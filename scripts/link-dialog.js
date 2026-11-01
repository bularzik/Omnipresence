import { SyncRegistry } from './sync-registry.js';
import { SyncEngine } from './sync-engine.js';
import { linkActor } from './link-actor.js';
import { filterCandidates } from './sync-logic.js';

const L = (key, data) => data
  ? game.i18n.format(`OMNIPRESENCE.link.${key}`, data)
  : game.i18n.localize(`OMNIPRESENCE.link.${key}`);
const esc = s => foundry.utils.escapeHTML(String(s ?? ''));
const norm = s => String(s ?? '').trim().toLowerCase();
// Accepts an ISO string (syncedAt) or epoch ms (_stats.modifiedTime).
const fmtDate = value => {
  const t = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(t) ? new Date(t).toLocaleString() : '—';
};

/**
 * "Link to synced character…" (op-87b): a two-step dialog. Step 1 picks the
 * shared character this local actor really is; step 2 shows the two copies
 * side by side and asks which one wins, then hands off to linkActor.
 */
export class LinkDialog {
  static async open(localActor) {
    const pack = game.packs.get(SyncEngine.PACK_ID);
    if (!pack) return;
    const ownId = SyncRegistry.isEnrolled(localActor) ? localActor.getFlag('omnipresence', 'id') : null;
    const candidates = (await pack.getDocuments())
      .filter(d => d.getFlag('omnipresence', 'id'))
      .filter(d => !d.getFlag('omnipresence', 'mergedInto'))
      .filter(d => d.getFlag('omnipresence', 'id') !== ownId)
      .filter(d => SyncRegistry.isGateUserFor(d))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (!candidates.length) {
      ui.notifications.info(L('none'));
      return;
    }

    let chosenId = candidates.find(d => norm(d.name) === norm(localActor.name))?.getFlag('omnipresence', 'id') ?? null;
    for (;;) {
      chosenId = await this._step1(localActor, candidates, chosenId);
      // Only an id from the list counts: DialogV2 substitutes the button's
      // action name when a callback returns null/undefined.
      const comp = candidates.find(d => d.getFlag('omnipresence', 'id') === chosenId);
      if (!comp) return;
      const winner = await this._step2(localActor, comp);
      if (winner === 'back') continue;
      if (!winner) return;
      try {
        await linkActor(localActor, comp, winner);
      } catch (err) {
        console.error('Omnipresence | link failed for', localActor.name, err);
        ui.notifications.error(game.i18n.format('OMNIPRESENCE.notifications.syncFailed', { name: localActor.name }));
      }
      return;
    }
  }

  /** @returns {Promise<string|null>} the chosen omnipresence id */
  static async _step1(localActor, candidates, preselectedId) {
    const { DialogV2 } = foundry.applications.api;
    const rows = candidates.map(d => {
      const id = d.getFlag('omnipresence', 'id');
      const owner = d.getFlag('omnipresence', 'ownerName') ?? game.i18n.localize('OMNIPRESENCE.link.gm');
      return `
        <div class="form-group" data-row data-id="${esc(id)}" data-name="${esc(d.name)}">
          <label class="radio">
            <input type="radio" name="omnipresence-link-target" value="${esc(id)}"${id === preselectedId ? ' checked' : ''}>
            <span><strong>${esc(d.name)}</strong><br>
            <span class="hint" style="opacity:.75;font-size:var(--font-size-12, 12px)">${esc(L('rowMeta', { owner, date: fmtDate(d.getFlag('omnipresence', 'syncedAt')) }))}</span></span>
          </label>
        </div>`;
    }).join('');

    const result = await DialogV2.wait({
      window: { title: L('title') },
      classes: ['omnipresence-link', 'omnipresence-link-step1'],
      content: `
        <p>${esc(L('step1', { name: localActor.name }))}</p>
        <input type="search" data-filter placeholder="${esc(game.i18n.localize('OMNIPRESENCE.onboarding.filterPlaceholder'))}">
        <div class="omnipresence-picker-list" data-list>${rows}</div>`,
      render: (_event, dialog) => {
        const form = dialog?.element?.querySelector('form');
        const filter = form?.querySelector('[data-filter]');
        if (!filter) return;
        const rowEls = [...form.querySelectorAll('[data-row]')];
        filter.addEventListener('input', () => {
          const shown = new Set(filterCandidates(
            rowEls.map(r => ({ id: r.dataset.id, name: r.dataset.name })), filter.value
          ).map(i => i.id));
          for (const r of rowEls) r.style.display = shown.has(r.dataset.id) ? '' : 'none';
        });
      },
      buttons: [
        {
          action: 'next',
          label: L('next'),
          default: true,
          callback: (_event, button) =>
            button.form.querySelector('input[name="omnipresence-link-target"]:checked')?.value ?? null
        },
        // false, not null: DialogV2 would turn null into the action name.
        { action: 'cancel', label: game.i18n.localize('OMNIPRESENCE.onboarding.cancel'), callback: () => false }
      ],
      rejectClose: false
    });
    return result || null;
  }

  /** @returns {Promise<'local'|'shared'|'back'|null>} */
  static async _step2(localActor, comp) {
    const { DialogV2 } = foundry.applications.api;
    const omniId = comp.getFlag('omnipresence', 'id');
    const stale = game.actors.find(a => a.id !== localActor.id && a.getFlag('omnipresence', 'id') === omniId);
    const card = (heading, name, date, items, effects) => `
      <div class="omnipresence-link-card" style="flex:1;border:1px solid var(--color-border-light-tertiary, #888);border-radius:4px;padding:8px">
        <div style="font-weight:bold;font-size:var(--font-size-16, 16px);margin-bottom:4px">${esc(heading)}</div>
        <p><strong>${esc(name)}</strong></p>
        <p class="notes">${esc(L('updated', { date }))}</p>
        <p class="notes">${esc(L('items', { n: items }))} · ${esc(L('effects', { n: effects }))}</p>
      </div>`;

    const result = await DialogV2.wait({
      window: { title: L('title') },
      classes: ['omnipresence-link', 'omnipresence-link-step2'],
      content: `
        <p>${esc(L('step2'))}</p>
        <div style="display:flex;gap:8px">
          ${card(L('thisWorld'), localActor.name, fmtDate(localActor._stats?.modifiedTime),
                 localActor.items.size, localActor.effects.size)}
          ${card(L('sharedCopy'), comp.name, fmtDate(comp.getFlag('omnipresence', 'syncedAt')),
                 comp.items.size, comp.effects.size)}
        </div>
        ${stale ? `<p class="notification warning">${esc(L('staleCopyWarning', { name: stale.name }))}</p>` : ''}`,
      buttons: [
        { action: 'local', label: L('keep'), callback: () => 'local' },
        { action: 'shared', label: L('use'), callback: () => 'shared' },
        // Back is the default: Enter must never overwrite either copy.
        { action: 'back', label: L('back'), default: true, callback: () => 'back' }
      ],
      rejectClose: false
    });
    return ['local', 'shared', 'back'].includes(result) ? result : null;
  }
}

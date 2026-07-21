import { SyncEngine } from './sync-engine.js';
import { JournalSync } from './journal-sync.js';
import { SyncRegistry } from './sync-registry.js';
import { filterCandidates } from './sync-logic.js';

/**
 * The shared actor/journal consent picker. Used at first sync (onboarding
 * mode, everything pre-checked, includes the macro opt-in) and from User
 * Configuration afterwards (manage mode, pre-checked from the stored
 * allow-list, no macro row — that toggle lives in the User Config panel).
 */
export class DocPicker {
  /**
   * @param {object} opts
   * @param {'onboarding'|'manage'} opts.mode
   * @param {{actorIds: string[], journalIds: string[]}|null} opts.preselected
   *   null → check every box (first-run behavior).
   * @returns {Promise<{actorIds: string[], journalIds: string[], macros: boolean}|null>}
   *   null when the user dismissed the dialog without confirming.
   */
  static async open({ mode = 'onboarding', preselected = null } = {}) {
    const candidates = await this._buildCandidates();
    return this._prompt(candidates, mode, preselected);
  }

  static async _buildCandidates() {
    const actors = await this._candidatesFor(SyncEngine.PACK_ID, game.actors);
    const journals = await this._candidatesFor(JournalSync.PACK_ID, game.journal);
    return { actors, journals };
  }

  /**
   * Named candidate docs for the picker: the user's enrolled docs already in
   * this world plus their enrolled docs in the shared pack (matched by
   * ownerName), deduped by omnipresence id, sorted by name.
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  static async _candidatesFor(packId, worldCollection) {
    const byId = new Map();

    for (const doc of worldCollection) {
      if (!doc.isOwner) continue;
      if (!SyncRegistry.isEnrolled(doc)) continue;
      const id = doc.getFlag('omnipresence', 'id');
      if (id) byId.set(id, doc.name);
    }

    const pack = game.packs.get(packId);
    if (pack) {
      const docs = await pack.getDocuments();
      for (const doc of docs) {
        const id = doc.getFlag('omnipresence', 'id');
        if (!id) continue;
        if (doc.getFlag('omnipresence', 'ownerName') !== game.user.name) continue;
        if (!byId.has(id)) byId.set(id, doc.name);
      }
    }

    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  static _renderContent({ actors, journals }, mode, preselected) {
    const esc = foundry.utils.escapeHTML;
    const L = key => game.i18n.localize(`OMNIPRESENCE.onboarding.${key}`);

    const isChecked = (kind, id) => {
      if (!preselected) return true;
      const list = kind === 'journal' ? preselected.journalIds : preselected.actorIds;
      return Array.isArray(list) && list.includes(id);
    };

    const rows = (items, kind) => items.map(({ id, name }) => `
        <div class="form-group" data-row data-id="${esc(id)}" data-name="${esc(name)}">
          <label class="checkbox">
            <input type="checkbox" data-kind="${kind}" value="${esc(id)}"${isChecked(kind, id) ? ' checked' : ''}>
            ${esc(name)}
          </label>
        </div>`).join('');

    // Controls are rendered only when there is something to filter; the
    // bulk buttons must be type="button" or clicking one submits the dialog.
    const section = (items, kind, noneKey, headingKey) => {
      if (!items.length) {
        return `
      <fieldset>
        <legend>${L(headingKey)}</legend>
        <p class="notes">${L(noneKey)}</p>
      </fieldset>`;
      }
      return `
      <fieldset>
        <legend>${L(headingKey)}</legend>
        <div class="omnipresence-picker-controls">
          <input type="search" data-filter="${kind}" placeholder="${L('filterPlaceholder')}">
          <button type="button" data-bulk="all" data-kind="${kind}">${L('selectAll')}</button>
          <button type="button" data-bulk="none" data-kind="${kind}">${L('selectNone')}</button>
        </div>
        <div class="omnipresence-picker-list" data-list="${kind}">${rows(items, kind)}</div>
        <p class="notes" data-counter="${kind}"></p>
      </fieldset>`;
    };

    const macrosFieldset = mode === 'onboarding' ? `
      <fieldset>
        <legend>${L('macrosHeading')}</legend>
        <div class="form-group">
          <label class="checkbox">
            <input type="checkbox" name="omnipresence-macros" checked>
            ${L('macrosLabel')}
          </label>
        </div>
      </fieldset>` : '';

    return `
      <p>${mode === 'manage' ? L('manageIntro') : L('intro')}</p>
      ${section(actors, 'actor', 'noneActors', 'actorsHeading')}
      ${section(journals, 'journal', 'noneJournals', 'journalsHeading')}
      ${macrosFieldset}
    `;
  }

  /**
   * Wire filtering, bulk select, and the counter for both sections. Select
   * all/none deliberately acts on the CURRENTLY VISIBLE rows only, which is
   * what makes filter-then-select-all useful; the counter line exists so that
   * scoping is legible rather than surprising.
   */
  static _wireControls(form) {
    for (const kind of ['actor', 'journal']) {
      const list = form.querySelector(`[data-list="${kind}"]`);
      if (!list) continue; // empty section renders no controls

      const rows = [...list.querySelectorAll('[data-row]')];
      const filterInput = form.querySelector(`[data-filter="${kind}"]`);
      const counter = form.querySelector(`[data-counter="${kind}"]`);
      const visibleRows = () => rows.filter(r => r.style.display !== 'none');

      const update = () => {
        const matched = new Set(
          filterCandidates(
            rows.map(r => ({ id: r.dataset.id, name: r.dataset.name })),
            filterInput.value
          ).map(item => item.id)
        );
        for (const row of rows) {
          row.style.display = matched.has(row.dataset.id) ? '' : 'none';
        }
        const selected = rows.filter(r => r.querySelector('input').checked).length;
        counter.textContent = game.i18n.format('OMNIPRESENCE.onboarding.counter', {
          shown: visibleRows().length,
          total: rows.length,
          selected
        });
      };

      filterInput.addEventListener('input', update);
      list.addEventListener('change', update);
      for (const button of form.querySelectorAll(`[data-bulk][data-kind="${kind}"]`)) {
        button.addEventListener('click', () => {
          const checked = button.dataset.bulk === 'all';
          for (const row of visibleRows()) row.querySelector('input').checked = checked;
          update();
        });
      }

      update();
    }
  }

  static async _prompt(candidates, mode, preselected) {
    const { DialogV2 } = foundry.applications.api;
    const titleKey = mode === 'manage'
      ? 'OMNIPRESENCE.onboarding.manageTitle'
      : 'OMNIPRESENCE.onboarding.title';
    const confirmKey = mode === 'manage'
      ? 'OMNIPRESENCE.onboarding.save'
      : 'OMNIPRESENCE.onboarding.confirm';

    const result = await DialogV2.wait({
      window: { title: game.i18n.localize(titleKey) },
      content: this._renderContent(candidates, mode, preselected),
      // DialogV2.wait's `render` callback fires as `render(event, dialog)` —
      // the second argument is the DialogV2 ApplicationV2 instance itself,
      // not an HTMLElement or jQuery object (confirmed against v13's
      // client/applications/api/dialog.mjs: `dialog.addEventListener("render",
      // event => render(event, dialog))`). The rendered form lives at
      // dialog.element, and DOM insertion happens before this event fires.
      // Warn rather than fail mute: if this ever resolves to nothing, the dialog
      // still renders and the checkboxes still work — only the filter, All/None,
      // and counter are dead, which is invisible without this line.
      render: (event, dialog) => {
        const form = dialog?.element?.querySelector('form');
        if (!form) {
          console.warn('Omnipresence | picker controls not wired: no form found on the dialog element');
          return;
        }
        this._wireControls(form);
      },
      buttons: [
        {
          action: 'confirm',
          label: game.i18n.localize(confirmKey),
          default: true,
          callback: (event, button) => this._collect(button.form, mode)
        }
      ],
      rejectClose: false
    });
    return result ?? null;
  }

  static _collect(form, mode) {
    const checked = sel => [...form.querySelectorAll(sel)].map(i => i.value);
    return {
      actorIds: checked('input[data-kind="actor"]:checked'),
      journalIds: checked('input[data-kind="journal"]:checked'),
      // Manage mode has no macro row; the User Config toggle owns that pref.
      macros: mode === 'onboarding'
        ? form.querySelector('input[name="omnipresence-macros"]').checked
        : true
    };
  }
}

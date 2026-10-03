import { SyncRegistry } from './sync-registry.js';
import { DocPicker } from './doc-picker.js';
import { runLoginReconcile } from './reconcile.js';

/**
 * After a save that admits new documents: a GM imports them now, a player's
 * wait for the next GM login (the import sections are GM-gated). A failure
 * here means "saved but not yet synced", so it gets its own message.
 */
export async function syncNewlyAdmitted() {
  try {
    await runLoginReconcile();
    ui.notifications.info(game.i18n.localize(
      game.user.isGM
        ? 'OMNIPRESENCE.notifications.manageSavedSyncingNow'
        : 'OMNIPRESENCE.notifications.manageSavedSyncsAtNextGmLogin'
    ));
  } catch (reconcileErr) {
    console.error('Omnipresence | reconcile after manage save failed', reconcileErr);
    ui.notifications.warn(game.i18n.localize('OMNIPRESENCE.notifications.manageSavedReconcileFailed'));
  }
}

export function registerUserConfigInjection() {
  Hooks.on('renderUserConfig', (app, html) => {
    // v13 ApplicationV2 passes an HTMLElement; guard against jQuery (v12 legacy).
    const root = html instanceof HTMLElement ? html : html[0];
    const userPrefs = SyncRegistry.getPrefs(game.user.id);

    const fieldset = document.createElement('fieldset');
    fieldset.innerHTML = `
      <legend>${game.i18n.localize('OMNIPRESENCE.userConfig.legend')}</legend>
      <div class="form-group">
        <label for="omnipresence-actors">${game.i18n.localize('OMNIPRESENCE.userConfig.actorSync')}</label>
        <div class="form-fields">
          <input type="checkbox" id="omnipresence-actors" name="omnipresence-actors">
        </div>
        <p class="hint">${game.i18n.localize('OMNIPRESENCE.userConfig.actorSyncHint')}</p>
      </div>
      <div class="form-group">
        <label for="omnipresence-macros">${game.i18n.localize('OMNIPRESENCE.userConfig.macroSync')}</label>
        <div class="form-fields">
          <input type="checkbox" id="omnipresence-macros" name="omnipresence-macros">
        </div>
        <p class="hint">${game.i18n.localize('OMNIPRESENCE.userConfig.macroSyncHint')}</p>
      </div>
      <div class="form-group">
        <label for="omnipresence-journals">${game.i18n.localize('OMNIPRESENCE.userConfig.journalSync')}</label>
        <div class="form-fields">
          <input type="checkbox" id="omnipresence-journals" name="omnipresence-journals">
        </div>
        <p class="hint">${game.i18n.localize('OMNIPRESENCE.userConfig.journalSyncHint')}</p>
      </div>
      <div class="form-group">
        <label>${game.i18n.localize('OMNIPRESENCE.userConfig.manageDocs')}</label>
        <div class="form-fields">
          <button type="button" id="omnipresence-manage-docs">
            ${game.i18n.localize('OMNIPRESENCE.userConfig.manageDocsButton')}
          </button>
        </div>
        <p class="hint">${game.i18n.localize('OMNIPRESENCE.userConfig.manageDocsHint')}</p>
      </div>
    `;

    // In v13, html is the outer <form> dialog element; the real scrollable content
    // lives in a child div. Evaluate selectors in priority order (not as a combined
    // list) so a more-specific inner element always wins over a broader outer one.
    const container = root.querySelector('[data-application-part="form"]')
      ?? root.querySelector('.standard-form.scrollable')
      ?? root.querySelector('.window-content')
      ?? root;
    const footer = container.querySelector('.form-footer, footer, .window-footer');
    container.insertBefore(fieldset, footer ?? null);

    const actorsInput = fieldset.querySelector('[name="omnipresence-actors"]');
    const macrosInput = fieldset.querySelector('[name="omnipresence-macros"]');
    const journalsInput = fieldset.querySelector('[name="omnipresence-journals"]');

    // Foundry re-renders the open UserConfig when user flags change, which can fire
    // renderUserConfig again with a stale closure before our prior setTimeout fires.
    // Re-reading prefs at setTimeout time ensures we always apply the current flag value.
    setTimeout(() => {
      if (!actorsInput.isConnected) return;
      const currentPrefs = SyncRegistry.getPrefs(game.user.id);
      actorsInput.checked = currentPrefs.actors !== false;
      macrosInput.checked = currentPrefs.macros !== false;
      journalsInput.checked = currentPrefs.journals !== false;
    }, 0);

    actorsInput.addEventListener('change', (e) => {
      SyncRegistry.setPrefs(game.user.id, { actors: e.target.checked });
    });

    macrosInput.addEventListener('change', (e) => {
      SyncRegistry.setPrefs(game.user.id, { macros: e.target.checked });
    });

    journalsInput.addEventListener('change', (e) => {
      SyncRegistry.setPrefs(game.user.id, { journals: e.target.checked });
    });

    const manageButton = fieldset.querySelector('#omnipresence-manage-docs');
    manageButton.addEventListener('click', async () => {
      try {
        const before = SyncRegistry.getSelection(game.user.id);
        const result = await DocPicker.open({ mode: 'manage', preselected: before });
        if (!result) return; // dismissed — change nothing

        await SyncRegistry.setSelection(game.user.id, {
          actorIds: result.actorIds,
          journalIds: result.journalIds,
          folderIds: result.folderIds
        });

        // A newly added document only auto-imports via the GM-gated section
        // of SyncEngine.onLogin()/JournalSync.onLogin() (both bail before it
        // for non-GM users), so it starts syncing right away for a GM, while
        // a player's newly added document waits for the next GM login.
        // Removals need no action (the doc simply stops syncing and its
        // local copy is left untouched).
        const added =
          result.actorIds.some(id => !before.actorIds.includes(id)) ||
          result.journalIds.some(id => !before.journalIds.includes(id)) ||
          result.folderIds.some(id => !(before.folderIds ?? []).includes(id));

        // Removals-only saves used to give no feedback at all (op-tb6). The
        // write is wholesale: the list is re-based to the rendered rows, so an
        // id whose document is neither local nor in the pack is dropped —
        // intended, such a doc cannot auto-import anyway.
        if (!added) {
          ui.notifications.info(game.i18n.localize('OMNIPRESENCE.notifications.manageSavedRemovedOnly'));
        }

        // The selection write above already succeeded, so a sync failure
        // gets its own message instead of the outer catch's manageFailed.
        if (added) await syncNewlyAdmitted();
      } catch (err) {
        // Never leave partial selection state behind: setSelection above is a
        // single write, so a failure either wrote all of it or none of it.
        console.error('Omnipresence | manage synced documents failed', err);
        ui.notifications.warn(game.i18n.localize('OMNIPRESENCE.notifications.manageFailed'));
      }
    });
  });
}

import { SyncRegistry } from './sync-registry.js';
import { FolderSync } from './folder-sync.js';
import { syncNewlyAdmitted } from './user-config.js';

/**
 * "Shared from other worlds" in the Journal sidebar: shared folders this user
 * gates that are not in this world yet, each with a Sync here button. The
 * section exists only while there is something to list. Sync here is the
 * explicit per-world opt-in — the folder joins the user's allow-list; a GM
 * imports it at once, a player's waits for the next GM login.
 */
export class FolderDirectory {
  static register() {
    Hooks.on('renderJournalDirectory', (app, html) => this._render(html));
  }

  /** Redraw after anything that can change the rows (login sync, a click). */
  static refresh() {
    ui.journal?.render();
  }

  static _render(html) {
    const root = html instanceof HTMLElement ? html : html[0];
    if (!root || !game.ready) return;
    // Partial re-renders keep the old section: always start clean.
    root.querySelector('.omnipresence-shared-folders')?.remove();

    const rows = FolderSync.sharedRows();
    if (!rows.length) return;

    const esc = foundry.utils.escapeHTML;
    const L = key => game.i18n.localize(`OMNIPRESENCE.sharedFolders.${key}`);
    const section = document.createElement('section');
    section.className = 'omnipresence-shared-folders';
    section.innerHTML = `
      <h3>${L('heading')}</h3>
      <ul class="plain">
        ${rows.map(({ id, name, waiting }) => `
          <li data-root-id="${esc(id)}">
            <span class="name"><i class="fas fa-folder"></i> ${esc(name)}</span>
            ${waiting
              ? `<span class="waiting">${L('waiting')}</span>`
              : `<button type="button" data-action="omnipresence-sync-here">${L('syncHere')}</button>`}
          </li>`).join('')}
      </ul>`;

    for (const button of section.querySelectorAll('[data-action="omnipresence-sync-here"]')) {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        const rootId = button.closest('li').dataset.rootId;
        try {
          await SyncRegistry.addToSelection(game.user.id, 'folder', rootId);
          await syncNewlyAdmitted();
        } catch (err) {
          console.error('Omnipresence | sync here failed for', rootId, err);
          ui.notifications.warn(game.i18n.localize('OMNIPRESENCE.notifications.manageFailed'));
        } finally {
          this.refresh();
        }
      });
    }

    const list = root.querySelector('.directory-list');
    if (list) list.before(section);
    else root.prepend(section);
  }
}

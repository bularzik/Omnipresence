import { SyncRegistry } from './sync-registry.js';

export function registerUserConfigInjection() {
  Hooks.on('renderUserConfig', (app, html) => {
    // v13 ApplicationV2 passes an HTMLElement; guard against jQuery (v12 legacy).
    const root = html instanceof HTMLElement ? html : html[0];
    const userPrefs = SyncRegistry.getPrefs(game.user.id);

    const fieldset = document.createElement('fieldset');
    fieldset.innerHTML = `
      <legend>${game.i18n.localize('OMNIPRESENCE.userConfig.legend')}</legend>
      <div class="form-group">
        <label>
          <input type="checkbox" name="omnipresence-actors"${userPrefs.actors !== false ? ' checked' : ''}>
          ${game.i18n.localize('OMNIPRESENCE.userConfig.actorSync')}
        </label>
      </div>
      <div class="form-group">
        <label>
          <input type="checkbox" name="omnipresence-macros"${userPrefs.macros !== false ? ' checked' : ''}>
          ${game.i18n.localize('OMNIPRESENCE.userConfig.macroSync')}
        </label>
      </div>
    `;

    // Insert before the footer / submit button group.
    const form = root.querySelector('form') ?? root;
    const footer = root.querySelector('.form-footer, footer, .window-footer');
    form.insertBefore(fieldset, footer);

    fieldset.querySelector('[name="omnipresence-actors"]').addEventListener('change', (e) => {
      SyncRegistry.setPrefs(game.user.id, { actors: e.target.checked });
    });

    fieldset.querySelector('[name="omnipresence-macros"]').addEventListener('change', (e) => {
      SyncRegistry.setPrefs(game.user.id, { macros: e.target.checked });
    });
  });
}

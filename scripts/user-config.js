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

    // Foundry re-renders the open UserConfig when user flags change, which can fire
    // renderUserConfig again with a stale closure before our prior setTimeout fires.
    // Re-reading prefs at setTimeout time ensures we always apply the current flag value.
    setTimeout(() => {
      if (!actorsInput.isConnected) return;
      const currentPrefs = SyncRegistry.getPrefs(game.user.id);
      actorsInput.checked = currentPrefs.actors !== false;
      macrosInput.checked = currentPrefs.macros !== false;
    }, 0);

    actorsInput.addEventListener('change', (e) => {
      SyncRegistry.setPrefs(game.user.id, { actors: e.target.checked });
    });

    macrosInput.addEventListener('change', (e) => {
      SyncRegistry.setPrefs(game.user.id, { macros: e.target.checked });
    });
  });
}

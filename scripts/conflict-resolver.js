export class ConflictResolver {
  /**
   * Prompt the user to resolve a sync conflict.
   * Calls onKeepLocal() or onUseShared() depending on the user's choice.
   * Does not import SyncEngine — callers pass the callbacks to avoid circular deps.
   */
  static async resolve(localActor, compActor, { onKeepLocal, onUseShared }) {
    const localSyncedAt = localActor.getFlag('omnipresence', 'syncedAt') ?? '';
    const compSyncedAt = compActor.getFlag('omnipresence', 'syncedAt') ?? '';

    const fmt = (iso) => iso ? new Date(iso).toLocaleString() : '—';

    const content = `
      <div style="margin-bottom:12px">
        ${game.i18n.format('OMNIPRESENCE.conflict.message', { name: localActor.name })}
      </div>
      <div style="display:flex;gap:12px;margin-bottom:12px">
        <div style="flex:1;border:1px solid var(--color-border-light-tertiary);border-radius:4px;padding:10px">
          <div style="font-size:11px;font-weight:bold;text-transform:uppercase;margin-bottom:4px">
            ${game.i18n.localize('OMNIPRESENCE.conflict.keepLocal')}
          </div>
          <div style="font-size:12px;color:var(--color-text-dark-secondary)">${fmt(localSyncedAt)}</div>
        </div>
        <div style="flex:1;border:1px solid var(--color-border-light-tertiary);border-radius:4px;padding:10px">
          <div style="font-size:11px;font-weight:bold;text-transform:uppercase;margin-bottom:4px">
            ${game.i18n.localize('OMNIPRESENCE.conflict.useShared')}
          </div>
          <div style="font-size:12px;color:var(--color-text-dark-secondary)">${fmt(compSyncedAt)}</div>
        </div>
      </div>
      <p style="font-size:11px;color:var(--color-text-dark-secondary);text-align:center">
        ${game.i18n.localize('OMNIPRESENCE.conflict.warning')}
      </p>
    `;

    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize('OMNIPRESENCE.conflict.title') },
      content,
      modal: true,
      buttons: [
        {
          action: 'local',
          label: game.i18n.localize('OMNIPRESENCE.conflict.keepLocal'),
          default: true
        },
        {
          action: 'shared',
          label: game.i18n.localize('OMNIPRESENCE.conflict.useShared')
        }
      ]
    });

    if (choice === 'local') {
      await onKeepLocal();
    } else {
      await onUseShared();
    }
  }
}

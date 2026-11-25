// Tiny shared flag so the admin panel can ask the resource to re-push identities
// on demand. The engine has NO game-DB access — only the hk-sportsbetting resource
// can read the `players` table. So "sync" = admin sets this flag, the resource
// picks it up on its next health poll (~15s) and runs its backfill. See
// [[hk-casino-admin-names-exclusion-ui]].
let identitySyncRequested = false

module.exports = {
  requestIdentitySync() { identitySyncRequested = true },
  // Read-and-clear: returns whether a sync was pending, then resets.
  consumeIdentitySync() {
    const was = identitySyncRequested
    identitySyncRequested = false
    return was
  },
  isIdentitySyncPending() { return identitySyncRequested },
}

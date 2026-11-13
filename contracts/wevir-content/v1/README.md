# Wevir content records

Proposed schemas for decrypted Wevir records inside `wevir-sync/1` packs. The gateway wire contract remains in [`wevir-sync/v1`](../../wevir-sync/v1/); Host JSON-RPC has its own version.

Generate from the protocol package with `node packages/protocol/scripts/sync-content.ts`. Fixtures are synthetic. The schema files describe structure; `version.json` lists semantic checks that consumers must also implement. A valid schema does not prove source identity, reference integrity, safe paths or permission to execute anything.

Encryption uses the shared gateway crypto vectors. These artifacts do not assert live service, disaster recovery, platform or end-to-end interoperability acceptance.

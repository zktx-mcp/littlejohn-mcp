# Little John MCP

Little John MCP is a local Robinhood Chain MCP application and interactive CLI. It
reads assets and contracts, constructs USDG / Stock Token exchange decisions,
requests the directly confirmed transaction in the connected wallet through WalletConnect, and records
received hashes and actual transaction results locally.

This document describes the source checkout. For an installed published artifact,
use the documentation at that release's source revision.

The current support projection is in [Product Policy](https://github.com/zktx-mcp/littlejohn-mcp/blob/main/docs/PRODUCT_POLICY.md#current-support).
Exchange actions are implemented. Robinhood Wallet transaction and replacement
behavior is not qualified. The package makes no executable or receipt-verified
support claim.
Data signing supports personal messages and EIP-712 typed data through direct
App controls and interactive CLI. Physical qualification with Robinhood Wallet
and each MCP Host application is incomplete.

## Install a published release

Use Node.js satisfying the package's `engines` field:

```sh
npm install --global @zktx.io/littlejohn-mcp
littlejohn-mcp --help
```

## Install from source

From a repository checkout using the same Node.js requirement:

```sh
npm ci
LITTLEJOHN_MCP_RELEASE_OUTPUT=/absolute/path/littlejohn-mcp.tgz npm run release:check
npm install --global /absolute/path/littlejohn-mcp.tgz
littlejohn-mcp --help
```

The release check creates the tarball only after its automated package checks
pass. It does not publish to npm or qualify a physical Wallet. SQLite is an npm
dependency; a separate SQLite server or command-line installation is unnecessary.
Its native addon installation remains part of the npm install. An installation
error must be resolved before starting the program.

## Connect an MCP Host

MCP Host terminology is defined in
[Architecture](https://github.com/zktx-mcp/littlejohn-mcp/blob/main/docs/ARCHITECTURE.md#mcp-host-terminology).

Configure a local stdio server named `littlejohn-mcp` in the MCP Host's MCP settings:

```json
{
  "mcpServers": {
    "littlejohn-mcp": {
      "command": "littlejohn-mcp",
      "args": []
    }
  }
}
```

Use the installed executable's absolute path if the MCP Host does not inherit the
shell's executable search path. No website, public server, browser login, or
navigable loopback page is needed. The no-argument process serves MCP; CLI
commands use the same local backend and Wallet session.

For an optional RPC endpoint, add `LITTLEJOHN_MCP_RPC_URL` to that server's environment.
Omitting it uses Runtime's public default. Do not set an empty string. A supplied
URL must pass the current HTTPS configuration admission; failure does not switch
to another provider. Keep URLs containing credentials in the MCP Host's secure
configuration rather than command arguments. The standard setup field is in
[server.json](https://github.com/zktx-mcp/littlejohn-mcp/blob/main/server.json).

`LITTLEJOHN_MCP_DATA_DIR` selects a different local profile directory.
`LITTLEJOHN_MCP_WALLETCONNECT_PROJECT_ID` overrides the Wallet adapter's project ID.
All processes sharing a profile must use the same configuration. The backend
uses its fixed loopback port; a foreign owner is an error, not a reason to select
another port. Complete configuration behavior belongs to
[Architecture](https://github.com/zktx-mcp/littlejohn-mcp/blob/main/docs/ARCHITECTURE.md#local-process-model).

## Backend lifetime and maintenance

Normal MCP and CLI use automatically start an independent local backend. It
keeps the Wallet session and pending work alive after a Host closes its MCP
connection. The background Node process and its SDK worker continue using
memory and local files until explicitly stopped, terminated by the operating
system, or stopped by a fatal backend failure. There is no idle shutdown.

Use the same profile and configuration as the connected clients:

```sh
littlejohn-mcp runtime status --json
littlejohn-mcp runtime stop --json
```

These commands do not start a backend. Stop affects all clients sharing that
backend, but does not revoke an approved Wallet session. It stops one observed
backend generation; a later ordinary client request can start another. Pause
the affected MCP connections before maintenance, updates, uninstalling or
removing an npx cache, then stop the backend and confirm `released` before
removing its files. Configure other Host applications directly in those apps.

If stop returns `shutdown_unconfirmed`, preserve its target. The printed
`runtime status --shutdown <owner-instance-id>` command reads that generation's
saved result without starting or stopping anything. A missing listener or a
stop acknowledgement alone does not prove release. An incompatible installed
package or configuration fails closed; Little John MCP does not terminate or update
that other process automatically.

If a different profile or installed version owns the port, pause the affected
Host connections and use that backend's original trusted installation, profile
and configuration to run `runtime stop`. A new version cannot stop an
incompatible backend. If that installation is unavailable or the backend no
longer responds, identify the exact Little John MCP backend in your operating
system's process tools and terminate it manually. Do not terminate every Node
process or delete a database or credential to clear a port conflict. A process
reported by an unauthenticated listener is not a trusted termination target.
Confirm that the backend and its SDK worker no longer use the profile before
removing files. Manual termination does not prove a request was cancelled or
resources were released; inspect the original operation after recovery and do
not resend an uncertain transaction or signing request.

## Use the application

In an App-capable MCP Host, ask for the desired asset read or transaction decision
in ordinary language. Select the Stock Token, pool, sent or received quantity,
exact/maximum/minimum conditions, fee caps and execution deadline. Token units
are distinct from underlying shares. Little John MCP does not choose missing
transaction-critical conditions silently.

Use the App's direct control to request the displayed transaction in the Wallet.
The Wallet separately asks for approval. A model-visible tool cannot authorize
that request. An MCP Host without direct App controls remains unable to authorize a
transaction; the CLI is an independent interface.

The CLI exposes its complete current syntax through `littlejohn-mcp --help`:

- `littlejohn-mcp wallet connect` presents the connection decision and pairing QR.
- `littlejohn-mcp uniswap-v4 list-pools <stock-token-address>` lists the packaged
  candidates that remain in the current official asset snapshot. This is not a
  liquidity or best-route claim.
- `littlejohn-mcp exchange start ...` constructs a new decision and asks for one
  interactive `y` before requesting it in the Wallet. Both input and output must
  be a TTY; flags, redirected input and JSON output cannot confirm a transaction.
- `littlejohn-mcp exchange replace-fees ...` constructs a new decision from the
  independently read pending request. `exchange start --replaces <hash> ...`
  selects a new supported transaction at that observed nonce. Neither replays a
  saved request or guarantees acceptance or inclusion.
- `littlejohn-mcp activity get <hash> --address <address>` and `activity list
  --address <address>` read local records only. `activity inspect <hash>
  --address <address>` explicitly rechecks the chain within a finite wait.

Each required token or router allowance is a separate decision and Wallet
request. Finishing an approval does not automatically send the next transaction.

Terminal QR presentation and its current profile limitation are documented in
[Architecture](https://github.com/zktx-mcp/littlejohn-mcp/blob/main/docs/ARCHITECTURE.md#current-state).
`littlejohn-mcp wallet connect` uses the QR renderer from the installed package.

## Sign data

Ask an App-capable MCP Host to create a signing decision for the exact message or
typed data. Inspect the complete data and domain, then use the direct control
and approve separately in the Wallet. A verified signature appears only in that
App result panel. Select the complete value and use your device's copy command;
the panel provides a Dismiss control. The MCP Host can observe
this private result. Closing the panel does not revoke the signature or erase
copies outside Little John MCP.

For CLI, put the payload in a user-owned JSON file. For example, this synthetic
message grants no application action:

```json
{"kind":"personal","encoding":"utf8","value":"Little John MCP signing check. This message grants no action."}
```

Run `littlejohn-mcp signing start --active --file message.json` and read the complete
decision before answering `y`. The output must also be an interactive terminal.
An `address` selector and the exact read/discard syntax are described by
`littlejohn-mcp --help`. A hex message explicitly uses `"encoding":"hex"`; a text
value starting with `0x` remains text. Typed input uses `"kind":"typed_data"`
with `types`, `primaryType`, `domain` and `message`; integer values are exact
decimal strings. It declares `EIP712Domain` explicitly and uses a distinct
message type. A supplied domain chain must be Robinhood Chain.

An existing send-only session needs explicit disconnect/connect approval for
the additional signing methods. Missing permission never triggers automatic
reconnection. This feature does not submit signatures to services, broadcast
transactions or create ledger entries. Its verification profile is a 65-byte
secp256k1 signature; contract-account signature validation is unavailable.
Late responses are discarded and unknown delivery never triggers another request.
No signature cache, durable signature record or later signature-retrieval command
exists. CLI scrollback and user-owned input files or copies are outside product
disposal control. Exact signing authority and result meaning remain in
[Transaction Policy](https://github.com/zktx-mcp/littlejohn-mcp/blob/main/docs/TRANSACTION_POLICY.md#data-signing).

## Results and local state

A returned hash is not execution success. Records distinguish included success,
revert, observed pending, not found and unavailable reads. Actual request and
effect comparisons remain separate from execution status. Missing evidence never
becomes a matching result. A revert still consumes gas.

Stopping a wait cannot cancel a delivered Wallet request. A hash observed later
during the original bounded SDK lifetime is recorded without a new network
lookup. An explicit query or a later transaction command can reconcile known
hashes. No timer, restart or completed approval resends a financial request.

Transaction decisions, unsigned requests and grants are temporary memory.
The execution ledger begins only with a received hash and its pre-send comparison
reference. It stores actual results, not a reusable transaction or full Review.
A saved transaction card can show its closed state or outcome without restoring
an expired or consumed decision, request or grant. Unrelated read snapshots and durable Wallet-management operations retain their own lifetimes.

Retained transaction, card and immutable-result history has no total row or
byte quota and is not deleted automatically. Disk use can grow; an actual write
failure preserves preceding committed values. A large MCP read returns its exact
saved source rather than truncating the result. Metadata and bounded result parts
carry the original bytes; a partial delivery is not a complete result. Reading
data never opens a decision or authorizes a Wallet request.

Default profile locations follow the operating system's application-state
directory. Owner-only files include the product database, separate WalletConnect
restoration store and local control credential. Do not treat an incompatible
profile as an automatic migration or erase it merely to bypass a startup error.

Exact authority and result meanings are defined by
[Transaction Policy](https://github.com/zktx-mcp/littlejohn-mcp/blob/main/docs/TRANSACTION_POLICY.md). Third-party notices and licenses
are included in the distributed package.

Little John MCP's source license is [MIT](https://github.com/zktx-mcp/littlejohn-mcp/blob/main/LICENSE).
Dependencies retain their separate terms in
[third-party notices](https://github.com/zktx-mcp/littlejohn-mcp/blob/main/THIRD_PARTY_NOTICES.txt)
and [licenses](https://github.com/zktx-mcp/littlejohn-mcp/tree/main/LICENSES),
including the WalletConnect Community License.

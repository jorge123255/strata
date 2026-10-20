# Strata iPhone companion bridge

The bridge connects the iPhone app to the Strata app already running on your Mac. It is a separate, opt-in process. Starting and quitting it does not restart Strata, change its address, download a model, or stop its engine.

## Connect your iPhone

1. Open Strata on the Mac. Put your Mac and iPhone on the same trusted Wi-Fi network.
2. Open **Strata Companion** on the Mac. Its pairing window shows a QR code and a six-digit code.
3. Open Strata on iPhone and scan the QR code in **Pair with Mac**, or paste the full invitation. The invitation includes the Mac's certificate fingerprint, address, and one-use code. A six-digit code by itself does not establish certificate trust.
4. Choose one of your Mac's configured API models, or an installed local model, in **Models**. Send a message from **Chats**.

An invitation lasts five minutes and allows five guesses in total. Choose **New invitation** on the Mac after it expires. The Mac pairing window also lists paired devices. **Remove** revokes a device immediately. The phone's disconnect action revokes its own session.

The Mac window refreshes automatically when an invitation is used, expires, or a paired device is removed. For manual setup, expand **Enter connection details manually** to copy the HTTPS address, certificate fingerprint, and pairing code individually.

The QR code is generated locally with Apple's Core Image framework. The native Mac package includes a compiled helper. Running the source directly can use the Swift command line tools; the manual invitation remains available if they are missing. No online QR service receives the invitation.

## Run from source

Requires Node 20 or newer and the macOS system OpenSSL command. No npm packages are installed.

```sh
cd apps/companion-bridge
npm start
```

The process emits one JSON `ready` line containing the local pairing-page URL, listener ports, and public certificate fingerprint. Open `adminURL` on this Mac. It includes a random page capability; do not share it. Pairing codes and session bearer tokens are never logged.

The authenticated HTTPS listener uses port **8787** and the Mac-only pairing window uses **127.0.0.1:8788**. Quit with Control-C. Command-line options:

```sh
node index.mjs --data-dir "/private/path/Strata Companion" \
  --port 8787 --admin-port 8788 --advertise-host 192.168.1.20
```

Normally the bridge discovers the running Strata host by its local process and listening port. If needed, supply an explicit loopback address with `--upstream http://127.0.0.1:47831`. Remote upstream addresses, redirects, paths, and embedded credentials are refused. The existing Strata host remains bound to loopback.

The default private data folder is `~/Library/Application Support/Strata Companion`. Its directory is mode 0700. Certificate, private key, session hashes, and phone conversations are mode 0600. Keep this folder to preserve your Mac's identity and pairing between launches. Changing the certificate requires pairing again. A token is 32 random bytes and is stored only as a hash on the Mac; the phone keeps its token in Keychain.

## What you can control

- View Mac connection, memory, model and active-request status.
- Choose among the API models already configured on the Mac. Provider credentials and endpoint addresses stay on the Mac. An API choice belongs to that paired phone and does not switch the desktop's selected chat model.
- Load an already downloaded local model or unload the phone's selected instance. Choosing an already running local model selects that instance for the phone without restarting it or changing the desktop's default. The existing host applies its own memory and active-request safeguards. Downloads, install operations, settings edits, files, shell commands, and arbitrary proxy routes are unavailable from the bridge.
- Send text messages through the Mac's real `/api/chat/stream` route and receive streaming responses. The companion forces the agent and tools off. Stopping a response aborts that request and preserves partial output.

Phone conversations are stored separately. The desktop currently stores its conversation index in its web view's local storage and provides no history API. This bridge does not copy or merge that storage. Each paired device can access only its own conversations.

When the Mac has no loaded local model, the initial phone selection is the first API model configured in Strata. Selecting another API model is private to the phone. Unloading an API selection clears that phone's selection; it does not stop a remote service. Removing a provider on the Mac makes an old phone selection unavailable until another model is selected.

## Phone API

All routes use HTTPS. The iPhone must compare the leaf certificate's SHA-256 DER fingerprint to the invitation before sending the pairing code or credentials. All routes except pairing require `Authorization: Bearer <token>`. Browser origins are rejected; no CORS access is provided.

| Method | Path | Request / result |
| --- | --- | --- |
| POST | `/v1/pair` | `{code,deviceName}` → `{token,macName}` |
| DELETE | `/v1/session` | Revokes this phone's session |
| GET | `/v1/status` | `{macName,hostConnected,modelName,engineState,tokensPerSecond,memoryUsedGB,memoryTotalGB,activeRequests}` |
| GET | `/v1/models` | `{models:[{id,name,size,state,detail,loaded,selected}],loadedModelId}` |
| POST | `/v1/models/load` | `{id}`; alias `/v1/models/:id/load` with `{}` |
| POST | `/v1/models/unload` | `{}` |
| GET | `/v1/chats` | `{chats:[{id,title,updatedAt}]}` |
| GET | `/v1/chats/:id` | `{id,title,messages:[{id,role,content}]}` |
| POST | `/v1/chat` | `{message,chatId?}` (`sessionId` accepted as alias) → SSE |
| POST | `/v1/chat/:id/cancel` | Stops this device's active conversation |
| POST | `/v1/requests/:id/cancel` | Stops a request ID previously streamed to this device |

SSE events are named `frame`, with a JSON `data:` line. The first frame has `type: "session"`, `chatId`, and `sessionId`. Subsequent frames retain the host's `type` (`start`, `delta`, `stats`, `done`, `error`, etc.). Text deltas use `text`; all frames include both conversation IDs. Only bounded text/status fields cross the bridge; tool payloads and host paths are excluded. An interrupted stream without a host `done` frame emits an error. A successful `load` can return 202 while the Mac completes loading.

`selected` identifies this phone's model choice. Several native models can have `state: "loaded"`; chat and unload resolve the selected model's ready instance explicitly. The initial native selection follows the Mac's default instance, rather than catalog order. Unloading clears the phone's selection, so another loaded instance is not selected silently.

## Verification

```sh
npm test
```

Tests use a temporary TLS identity and mock host. They cover certificate fingerprint/stability, default TLS rejection without a pin, pairing expiry/guess limits/replay, private token hashes, auth/revocation, narrow routes and methods, admin CSRF/DNS rebinding/escaping, sanitized provider selection, real NDJSON framing into SSE, per-device private history, stream truncation, and concurrent conversation rejection. They do not claim physical iPhone acceptance or real model inference; record those separately when performed.

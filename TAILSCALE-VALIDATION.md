# Tailscale companion connection — October 22, 2026

The existing bridge listened on all IPv4 interfaces, including the Mac's Tailscale address, but advertised only its LAN address. The iPhone stored one address and could not update an existing pairing. A phone away from home therefore kept trying the unreachable home address.

## Change

- Mac source `6cc421ca41f8c0e205b0ecf4b58c37181e50af9b` discovers the running local Tailscale client's own addresses, advertises validated numeric HTTPS origins through an authenticated connection endpoint, and shows the remote address in iPhone settings even after the invitation expires. Discovery is cached, bounded and read-only; it never changes Tailscale, firewall or routing settings.
- iPhone source `45e27a728b76c4ce6e9a498982e93e1f9ce5aa13` (build 36) learns alternate addresses and tries them for transient failures of ordinary GET requests. Messages, commands, streams and other mutations are never automatically replayed after an uncertain failure.
- Connection → Update Mac address checks the original certificate without sending the bearer token, then checks the existing pairing before saving. Failure, cancellation or a stale response retains the old connection. The same client instance is updated so shared bot and computer transports follow the new address.
- The original pairing URL remains the local notification identity. Changing addresses preserves the notification inbox and read state as well as the existing Keychain token, certificate pin and server history. Redirects remain rejected.

## Validation

- Bridge: 145 passing checks; host companion/routes: 15 passing checks. An independent backend run passed 22 focused checks.
- Mac settings browser workflow passed with no page errors or external requests, covering dark/light layouts and the paired state after the invitation expires. Type checking and production UI compilation passed. A fresh locked native release build and all 29 native tests passed.
- Final iPhone unit run: 286 cases, 284 passed and two fixture-only skips, zero failures. The native pinned-TLS simulator workflow and a separate TLS rejection workflow each passed. The disposable fixture retained exactly one pairing across an address update, history checks and relaunch. Wrong-certificate and redirect cases did not disclose credentials.
- Independent reviews accepted the exact Mac and iPhone source with no open P1/P2 findings. The signed Mac candidate passed its complete source, resource and signature gate; activation is recorded separately below.

## Acceptance boundary

Local unauthenticated TLS checks reached both the Mac loopback and its Tailscale address and observed the same existing certificate. This does not establish physical-iPhone connectivity from another network, Tailscale access-policy acceptance, or cellular connectivity. No owner conversation prompt, Maya change, guest restart, or Tailscale configuration change was used for this work.

Both devices must have Tailscale connected, and the Mac must be awake with Strata running. An existing phone pairing can learn the alternate address while connected at home; otherwise build 36 can verify and save the Mac's Tailscale address manually. No re-pairing is required.

## Installation

The Mac update was activated at **2026-10-22 21:56:19 UTC**. Two complete idle snapshots were **16.87 seconds apart**, followed by another complete snapshot immediately before native Quit. The old app and owner data were preserved in a unique private backup, then the signed candidate was atomically installed at `/Applications/Strata.app` and reopened at the same host origin.

Independent postactivation checks passed with no open P1/P2 findings: exact installed source/resources/native compiler output and strict recursive signature, **173 conversations / 644 messages, three paired devices, nine saved connections**, the original CUA runtime/disk/process identities, and unchanged teams, connectors, skills, notifications and action journals. There was no schema migration. Both local TLS listener checks retained the original leaf certificate. Native Mac navigation confirmed that the installed settings panel shows the Tailscale address; the original 54-character unsent team draft was restored without sending it.

Signed iPhone **build 36** is independently accepted, with the same development profile, signing certificate, entitlements and Keychain implementation as build 35. All 55 tracked iOS inputs and 30 committed production Swift files match the frozen source; one Xcode-generated asset source is separately accounted for. Its complete 12-file app manifest is bound to the acceptance receipt. The user subsequently connected and unlocked the iPhone and explicitly authorized installation. Build **36 was installed successfully on the paired iPhone 15 Pro**, and a fresh CoreDevice application inventory independently reported `com.strata.companion.ios` at bundle version `36`. The app was not launched. Away-from-home iPhone connectivity remains unverified; installation is not offsite acceptance.

Private receipts are under `Strata-iphone-evidence/strata-tailscale-20261022T212402Z-6562809e`, including `independent-activation-acceptance.json`, `tls-after-activation.json`, `device-build36-acceptance.json`, and activation attempt `attempt-tailnet-6a7153ec`. The task-owned simulator and TLS fixtures were cleaned up; existing paired simulators were untouched.

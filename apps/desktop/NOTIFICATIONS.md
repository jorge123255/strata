# Notifications

Strata can alert you when a reply is ready, a teammate posts, work finishes or needs attention, or an action needs approval. Notification banners keep message contents private. Open a banner to go to its conversation and review the update or action there.

Open **Notifications** in Strata to enable alerts and choose their categories and sound. Each device keeps its own choices. Use a conversation's notification control to mute or unmute it. The notification inbox keeps recent alerts available inside the app. Connecting or restarting does not alert you about all your old history.

## Mac

Allow Strata when macOS asks for notification permission. If you previously denied permission, change it in **System Settings → Notifications → Strata**. Keep Strata running. Alerts can arrive while its window is hidden or another app is in front. The conversation you are actively reading stays quiet.

Use **Send test notification** in the notification settings to check macOS delivery without sending a message or running a bot. Clicking that test opens the notification settings.

## iPhone

Enable notifications in Strata's notification settings and allow the iOS permission request. The notification screen shows whether the installed build and paired Mac are ready for Apple push delivery.

An ordinary development build without Apple's push capability can show new alerts while Strata is active. It cannot receive new server alerts while the phone app is suspended or closed. Closed-app delivery needs all of the following:

- A Strata iPhone build signed with an APNs-enabled provisioning profile for `com.strata.companion.ios`.
- Notification permission on the phone and a successful Apple device-token registration.
- A running, paired Strata Mac with an authorized APNs provider configured.

The optional **PushDebug** and **PushRelease** build configurations enable the push entitlement. Debug uses Apple's sandbox; release uses production. The ordinary Debug/Release configurations remain usable with profiles that do not include APNs. Building an unsigned push configuration verifies code and settings only; it does not establish push registration or delivery.

See Apple's instructions for [registering with APNs](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns) and [token-based provider authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).

## Configure a self-hosted Apple push provider

Use an APNs signing key authorized for the Apple Developer team and Strata app topic. Keep the `.p8` key private and outside the repository and application bundle. Strata never distributes a developer's signing key to other users.

Create a private `apns-provider.json` in Strata's data directory with exactly these fields:

```json
{
  "teamId": "YOURTEAMID",
  "keyId": "YOURKEYID0",
  "keyPath": "/absolute/private/path/AuthKey.p8"
}
```

Use your actual ten-character team and key identifiers. The file contains a reference to the key; the key contents stay in their private file. Strata reads this configuration when its host starts. Restart Strata after changing it, once its work is idle.

For headless/self-hosted setups, `STRATA_APNS_CONFIG_PATH` can select that configuration file. A complete `STRATA_APNS_TEAM_ID`, `STRATA_APNS_KEY_ID` and `STRATA_APNS_KEY_PATH` environment configuration takes precedence. The sender uses Apple's fixed sandbox or production service and the fixed Strata iPhone topic.

Provider configuration, phone registration and actual delivery are separate states. A configured sender alone does not mean a phone can receive notifications. Removing a paired device or disabling pairing prevents further push delivery to it. A banner cannot approve an action, start work or run a command.

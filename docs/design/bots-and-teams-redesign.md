# Bots and teams redesign (Mac + iPhone)

Goal: make Strata's bots feel like Grok Bot. Bots and team rooms are the primary navigation, rooms scale to 12+ members, and the iPhone mirrors the Mac.
Host-side fixes (limits, turn queue, direct routing, member cap, live push) ship separately from Bot Strata Dev and are assumed here.

## 1. Mac sidebar (`apps/host/src/app/Sidebar.tsx`)
Replace the single "Bots" nav link + workspace chat folders as the main list with:

1. Top: Search (Cmd-K), New bot, New room.
2. **Sections** (user-named, collapsible, drag to reorder; default sections "Bots" and "Rooms"). A bot or room can be moved to any section from its context menu.
3. **Bot row**: avatar, name, one-line status ("Working on …", "Idle", "Paused", "Error"), unread dot/count, pinned state. Click opens that bot's chat.
4. **Room row**: stacked avatars (up to 3, then "+N"), room name, member count, unread count, "typing" indicator when any member is replying.
5. Hidden bots/rooms go to a "Hidden" entry at the bottom, not deleted.
6. Workspace chat folders move under a collapsed "Chats" section at the bottom (existing 20-row cap + "View all" kept).
Connectors / Models / Skills / Monitor move into the More menu or a compact icon row.

## 2. Bot page
Header: avatar, name, status, tabs **Chat · Overview · Routines · Files · Computer**. Settings (profile, model, connectors, folder access) in a right-side info pane opened from the header, not separate screens.

## 3. Room page (`BotTeamChannel.tsx`)
- **Members pane** on the right: searchable list of all members with status (working/idle/paused), coordinator badge, add/remove. Replaces the 4-face welcome cap and 3-face badge as the only way to see who's in it.
- **Composer @-mentions**: typing `@` opens a member picker; `@everyone` is an explicit chip. No mention = "let the coordinator decide". Replaces the flat checkbox "Who should respond?" fieldset.
- Mentioned bots get the message directly (no coordinator hop).
- **Live activity**: a row per bot currently replying ("Openflix is typing…"), max 2 at once per host queue; queued bots shown as "Up next: …". A bot that passes posts nothing (optional faint "passed").
- Threads: replies to a message collapse into a thread under it to keep 12-bot rooms readable.
- Stop button in the composer cancels the current round for everyone.
- Room settings in the info pane: name, coordinator, members (cap 12 enforced by host, UI shows "12 / 12"), turn/time/hop limits that actually apply.

## 4. iPhone (`apps/ios/StrataMobile`)
Split `BotWorkspaceViews.swift` (2,245 lines) into per-screen files. Structure:
- **Home**: same sections as the Mac sidebar (bots + rooms rows with status and unread), pull to refresh, search at top.
- Tap a bot -> chat; tap a room -> room chat with the same @-mention composer and typing rows; members sheet from the header.
- Bot/room info as a sheet (not new tabs).
- Tab bar: **Home · Activity (notifications) · Mac (pairing, models)**.
- Live updates over the host push channel; polling only as fallback.

## 5. Build order
1. Host fixes (Bot Strata Dev, separate PR).
2. Mac sidebar sections + bot/room rows.
3. Room members pane + @-mention composer + typing rows.
4. iPhone home + room screen on the same data.
5. Polish: threads, hidden list, drag-reorder.

## Acceptance
- A 12-member room: "@everyone hi" yields at most 2 bots replying at a time, all visible as they land, no coordinator summary flood.
- Every bot and room reachable from the sidebar in one click; unread counts match on Mac and iPhone.

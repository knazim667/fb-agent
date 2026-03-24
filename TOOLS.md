# TOOLS

## Notes For The Planner
- Prefer current context before re-listing or re-scanning.
- Use one tool at a time when the user asks for a sequence.
- After each tool result, decide whether another tool is still needed.
- Avoid showing unrelated old posts when the current group has no matches.

## Core Tools
- `list_groups`
  Show tracked groups, optionally filtered to Amazon-related groups.
- `search_groups`
  Find new groups by keyword and attempt joining.
- `open_group`
  Open a selected tracked group.
- `scan_current_group`
  Scan the currently open group for lead-like posts.
- `scan_joined_groups`
  Scan joined groups for qualified posts.
- `show_posts`
  Show the current matched post list.
- `draft_comment`
  Draft a comment for a selected post.
- `comment_post`
  Post a drafted or generated comment.
- `check_notifications`
  Read recent notifications or comment-related notifications.
- `reply_notification`
  Reply to a selected notification thread.
- `draft_post`
  Draft a feed post or group post.
- `post_last_draft`
  Post the most recent saved draft.
- `sync_groups`
  Refresh joined-group state from Facebook.
- `verify_pending_groups`
  Check whether pending groups are now joined.

## Context Objects
- Current group
- Last listed groups
- Last matched posts
- Last notifications
- Last draft
- Recent conversation history

## Tool Use Principles
- Use the smallest useful tool first.
- Observe tool output before choosing the next step.
- Avoid repeating the same tool unless new context justifies it.

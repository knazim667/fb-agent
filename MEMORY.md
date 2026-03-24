# MEMORY

## Durable Facts
- This workspace is for a Facebook account assistant focused on Amazon seller lead generation and account management.
- The preferred model is chat-first, tool-driven, and context-aware.
- The operator wants natural conversation, not strict command syntax.

## Behavioral Constraints
- Do not start background housekeeping automatically.
- Prefer current context when the user refers to numbered groups, posts, or notifications.
- If no matching posts are found in a selected group, say that clearly and do not dump unrelated posts.

## Known Priorities
- Improve planner quality and follow-up understanding.
- Keep group, post, notification, and draft context stable across turns.

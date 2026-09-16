Run the **LaunchDarkly AutoFactory Phase 1** workflow on my current change set,
following the `autofactory` rule (@autofactory).

Work from the diff of this branch against its base. Go through all five phases
in order — research & plan, flag, metrics, tests, review — fetching each phase's
instructions from LaunchDarkly via the `get-ai-config` MCP tool and using the
native tools per the rule's tool-translation table.

Leave every edit in the working tree for me to review and commit — do not commit
or push. When you finish, summarize the flag and metrics you created (with
LaunchDarkly links), the manifest you wrote, and the review verdict.

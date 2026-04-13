#!/bin/bash
cat <<'EOF'
{
  "followup_message": "Before finishing, verify quality checks pass. Run:\n1. `npm run type:check`\n2. `npm run lint`\n3. `npm run format:check`\n\nFix any failures. If no code was modified or checks already verified, you're done."
}
EOF

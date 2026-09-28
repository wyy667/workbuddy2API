2026-09-26 local merge
Base: codebuddy-proxy-分享包-20260926.tar.gz
Preserved installed handleChat (with only external-model dispatch and credit accounting added), recordAccountFailure/Success, and pollBalances.
All upstream HTTP/network errors retry on one other eligible CodeBuddy account. Default active account failure streak >=3 switches to highest cached eligible balance. Successful completion resets streak. Streak is in memory.
Archive model fallback and CodeBuddy per-account inflight leases are not wired into retained handleChat. Metrics per-account lease counts therefore do not represent CodeBuddy chat concurrency.
Frontend: archive controls with local blue #1f93eb / pink #ff90ac light theme and neutral dark theme; system fonts, no Google Fonts dependency.
Backup: /root/workbuddy-before-merge-20260926-101431
Tests: mock retry/status/network/streak, highest balance; isolated no-credential HTTP smoke tests and deployed management HTTP checks. No browser visual regression or real third-party calls performed.

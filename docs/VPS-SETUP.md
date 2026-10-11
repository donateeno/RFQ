# VPS setup — Hostinger KVM 2 (Claude Code, n8n and OpenClaw already installed)

The target setup:

```
Your Claude Code / OpenClaw on the VPS ──branch + PR──► GitHub ──► CI tests + Claude review (comments)
                                                           │
                                         you read the review and click Merge  (your approval)
                                                           │
                                     Deploy workflow ──SSH──► VPS: deploy/deploy.sh
                                                           │
           https://rfq.<your-domain> ──► Traefik/Caddy ──► rfq app (Docker) ──► PostgreSQL (Docker volume)
                                                                 │        ▲
                                                 emails via n8n ◄┘        └── n8n: daily cost sync, 15-min Sheet copy
```

KVM 2 (2 vCPU / 8 GB RAM) runs this app (~150 MB) next to n8n and OpenClaw without trouble.

---

## 1. DNS
In your DNS (Hostinger hPanel → Domains → DNS), add an **A record**: `rfq` → the VPS IP. Wait until `ping rfq.<domain>` answers.

## 2. Check what owns ports 80/443
```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```
- A **traefik** container on 80/443 (Hostinger's n8n template uses this): set `PROXY=traefik`. Then find its network and settings:
  ```bash
  docker inspect $(docker ps -qf name=traefik) --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'   # → TRAEFIK_NETWORK
  docker inspect $(docker ps -qf name=traefik) --format '{{.Args}}' | tr ' ' '\n' | grep -E 'entrypoints|certresolver'
  ```
- If nothing listens on 80/443, set `PROXY=caddy`.
- If something else owns them (e.g. nginx), set `PROXY=` (empty) and point that proxy at `http://127.0.0.1:3000`.

## 3. A separate deploy user (keeps AI agents away from production)
Agents running as your normal user should **not** be in the `docker` group, because docker access is root-equivalent.
```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo mkdir -p /opt/rfq /opt/rfq-backups && sudo chown deploy:deploy /opt/rfq /opt/rfq-backups
sudo -iu deploy
ssh-keygen -t ed25519 -f ~/.ssh/github_ro -N ""      # read-only deploy key for git pull
cat ~/.ssh/github_ro.pub
```
In GitHub, open **donateeno/RFQ → Settings → Deploy keys → Add deploy key**, paste the key and leave *write access* **off**. Then:
```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/github_ro\n' >> ~/.ssh/config
git clone git@github.com:donateeno/RFQ.git /opt/rfq
```

## 4. Google sign-in
1. Go to https://console.cloud.google.com and create a project such as "EVE RFQ".
2. **APIs & Services → OAuth consent screen**: set User type to **Internal**, so only eve.co.th accounts can sign in.
3. **Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized JavaScript origins: `https://rfq.<domain>`. No redirect URI is needed.
4. Copy the Client ID. It goes into `GOOGLE_CLIENT_ID` in step 5.

## 5. Configure and start
```bash
cd /opt/rfq/deploy
cp .env.example .env && chmod 600 .env
for k in POSTGRES_PASSWORD SESSION_SECRET INTEGRATION_TOKEN; do sed -i "s/^$k=.*/$k=$(openssl rand -hex 32)/" .env; done
nano .env        # APP_DOMAIN, APP_BASE_URL, GOOGLE_CLIENT_ID, NOTIFY_WEBHOOK_URL, PROXY, TRAEFIK_*
bash deploy.sh   # builds, starts, waits for /healthz
```
Open `https://rfq.<domain>` and sign in. Accounts listed in `BOOTSTRAP_ADMINS` / `BOOTSTRAP_SUPERVISORS` get their roles. Everyone else at eve.co.th joins as SALES automatically.

Firewall: in **hPanel → VPS → Firewall**, allow only 22, 80 and 443. PostgreSQL is never published, and the app is bound to 127.0.0.1.

Backups:
```bash
(crontab -l 2>/dev/null; echo "15 2 * * * /opt/rfq/deploy/backup.sh >> /opt/rfq-backups/backup.log 2>&1") | crontab -
```
Also turn on Hostinger's weekly VPS snapshot.

## 6. GitHub: AI review + your approval + auto-deploy
1. **Claude review token**: on the VPS, run `claude setup-token` (you're signed in to Claude Code there). In GitHub, go to **Settings → Secrets and variables → Actions → New repository secret** and add `CLAUDE_CODE_OAUTH_TOKEN`.
2. **Claude GitHub App**: inside Claude Code, run `/install-github-app` and pick `donateeno/RFQ`. Alternatively install it from https://github.com/apps/claude.
3. **Deploy secrets** (same page):
   - `VPS_HOST`: the VPS IP.
   - `VPS_USER`: `deploy`.
   - `VPS_SSH_KEY`: the private key of a new key pair whose public key is in `/home/deploy/.ssh/authorized_keys`. Create it with `ssh-keygen -t ed25519 -f gh_deploy -N ""`.
   - `VPS_KNOWN_HOSTS`: the output of `ssh-keyscan <VPS IP>`.
4. **Settings → Environments → New environment `production`**. Optionally add yourself as a required reviewer to get a second approval step before each deploy.
5. **Protect `main`**: go to **Settings → Rules → Rulesets → New branch ruleset**, set target branch `main`, then enable:
   - *Restrict deletions*
   - *Block force pushes*
   - *Require a pull request before merging*
   - *Require status checks to pass*: `Server tests (Node + PostgreSQL)`, `Docker image builds`, `review`

   If the AI agents push **with your own GitHub account**, leave "required approvals" at 0. GitHub won't let you approve your own PR, so your approval is clicking **Merge** after reading Claude's review. If agents use a separate GitHub account or bot, set required approvals to 1 and enable *Require review from Code Owners*.
6. Optional PR alert: import `deploy/n8n/github-pr-reviewed.json` into n8n, then add the secrets `N8N_PR_WEBHOOK_URL` and `N8N_PR_WEBHOOK_TOKEN`.

The daily loop: ask Claude Code or OpenClaw on the VPS for a change → it opens a PR → CI and the Claude review run → you get an email → you read the verdict and click Merge → it's deployed about 2 minutes later.

## 7. n8n workflows (`deploy/n8n/`)
Import each file in **n8n → Workflows → Import from file**. Then set its credentials and IDs and activate it.

| File | Credentials | Set |
|---|---|---|
| `rfq-notify.json` | Header Auth "RFQ integration token" (`Authorization` = `Bearer <INTEGRATION_TOKEN>`), Gmail | Copy the webhook's **production URL** into `NOTIFY_WEBHOOK_URL` |
| `rfq-products-sync.json` | Google Sheets OAuth2, the same Header Auth | Spreadsheet ID of the GT file, `rfq.<domain>` |
| `rfq-sheets-mirror.json` | Google Sheets OAuth2, Header Auth | A spreadsheet with a tab `APP_Requests_Mirror` (share it only with people allowed to see cost) |
| `github-pr-reviewed.json` | Header Auth "GitHub → n8n token", Gmail | — |

## 8. Bring in the data (one time, as admin → ตั้งค่า → นำเข้าข้อมูล)
In each Google Sheet tab, use **File → Download → CSV**, then upload it with the matching type:
1. `_Cost&Price` → **cost_price_sheet**. `_CalDummy` → **cal_dummy_sheet**. The daily n8n sync keeps both fresh afterwards.
2. Joseph Space:
   - Project costs: CSV with `project_key, customer, description, cost` → **project_costs**.
   - `_Manual.Cal` → **landed_items**.
3. Old requests: upload `GT.EVE_RFQ`, `GT.FOSTER_RFQ`, `BT.EVE_RFQ`, `BT.FOSTER_RFQ` and `OFFI_RFQ`, each with its own type. Re-running is safe: existing IDs are skipped.

## 9. Updating by hand / rollback
```bash
sudo -iu deploy bash /opt/rfq/deploy/deploy.sh                       # latest main
cd /opt/rfq && git reset --hard <old-sha> && cd deploy && docker compose -f docker-compose.yml -f docker-compose.$PROXY.yml up -d --build   # rollback
```

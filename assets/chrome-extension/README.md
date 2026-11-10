# Aillium for Chrome

Lets Aillium work in your own Chrome (with your logins) instead of its own browser.

- Aillium opens its tabs in a purple **Aillium** tab group.
- Every page shows whether Aillium is in control, needs a decision, or has let go.
- Final steps (pay, send, submit, delete) wait for your approval in Aillium.
- **Stop**: right-click the toolbar icon, or use the options page. Aillium lets go of every tab and stays
  disconnected until you turn it back on.

## Install (unpacked, for now)

1. Chrome → `chrome://extensions` → turn on Developer mode → Load unpacked → pick this folder.
2. In Aillium, open Settings → Connect Chrome → Create pairing code.
3. Paste the code into the extension's options page and click Save and connect.

The extension connects out to `wss://<aillium runtime>/api/aillium/chrome/connect`. Nothing listens on your
computer.

## Local OpenClaw (advanced)

Leave the pairing code empty to use a local OpenClaw relay (`http://127.0.0.1:18792/`) with the gateway
token, as before.

# Ship **Permission** — the exact checklist

Everything below is prepped and waiting. This is the same Capacitor + Codemagic pipeline that
shipped ChordLoop. **Once you're signed into your accounts, do exactly this:**

1. **Create the app record** — App Store Connect → My Apps → **+** → New App:
   Name `Permission — Private Journal` · Bundle ID `com.jonathanbiles.permission` ·
   SKU `permission-001` · **Price = Free**. Copy the app's **Apple ID** (the number it gives you).

2. **Put this folder in a GitHub repo** named **`permission-app`** (any name works — if you change
   it, adjust the URLs in step 4).

3. **Turn on GitHub Pages** — repo **Settings → Pages → Deploy from a branch → `main` / `/docs`**.
   Your two required URLs go live in ~1 min:
   - Privacy: `https://<your-github-username>.github.io/permission-app/privacy.html`
   - Support: `https://<your-github-username>.github.io/permission-app/support.html`

4. **Build on Codemagic** — connect the repo, open the **`ios-testflight`** workflow:
   - Make sure your **App Store Connect API key** integration is attached (reuse your ChordLoop key —
     just name it `PermissionAPIKey`, or change that one line in `codemagic.yaml` to your key's name).
   - Paste the app's **Apple ID** into `APP_APPLE_ID` in `codemagic.yaml`.
   - **Run it.** It signs, builds, and uploads to TestFlight. (Mic/Face ID strings, export-compliance,
     audio session, icon + splash, and the native Face ID + voice plugins are all already wired in.)

5. **Test on your iPhone** via the **TestFlight** app (auto-distributes to you) — 60-second checklist:
   - Set passcode → force-quit → reopen asks for it
   - **Face ID** toggle in Settings turns on and unlocks (native)
   - **Write / Draw / Voice** (record + play back) all save
   - **Export** opens the share sheet · Airplane mode still works

6. **Submit** — in App Store Connect, paste the listing from
   `../Permission assets/Permission - App Store Listing.md`, upload the four
   `Permission-screenshot-*.png`, set **App Privacy → Data Not Collected**, paste the **Privacy +
   Support URLs** from step 3, attach the build, and tap **Submit for Review** (~1–3 days).

---

### Already done for you
Renamed + rebranded to Jessica's live site, Free, listing + privacy + support pages written, icon +
4 screenshots, native Face ID + native voice recording wired (with safe fallbacks), and the whole
Codemagic workflow. The only things left are the account/sign-in steps above.

### If a plugin ever errors the build (unlikely)
The native Face ID / voice plugins have web fallbacks, so the app still works without them. If the
Codemagic build fails on `capacitor-native-biometric` or `@capacitor-community/voice-recorder`,
delete that one line from `package.json` and re-run — then ping me and I'll pin a version. Same for
the on-device test: if Face ID or voice misbehaves, tell me what you saw and it's a quick fix.

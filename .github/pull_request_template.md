## Summary

<!-- 1–3 sentences. Why is this change needed and what does it do? -->

## Type of change

- [ ] feat — user-visible new capability
- [ ] fix — corrects a broken behaviour
- [ ] chore — tooling, deps, build, CI, internal cleanup
- [ ] docs — README / CONTRIBUTING / inline docs only
- [ ] refactor — no behaviour change
- [ ] perf — performance only

## Test plan

<!-- Concrete steps a reviewer can run to convince themselves the change works.
Include the command(s), expected output, and any manual UI verification. -->

- [ ] `npm run typecheck` passes
- [ ] `npm run build` produces a clean `dist/`
- [ ] `npm run package` produces a CWS-uploadable ZIP with `manifest.json` at the root
- [ ] Loaded `dist/` as an unpacked extension in Chrome and verified the change
- [ ] (if cloud) `cd cloud && npm run build` passes

## Chrome Web Store policy checklist

- [ ] No new permissions added (or, if added, justified in `Privacy practices` of the dashboard)
- [ ] No remote `<script>` / `eval()` / dynamic remote module imports introduced
- [ ] Privacy policy still accurately describes the data flow
- [ ] No secret, API key, or service-account JSON committed

## Related

<!-- Issue link, discussion, or external context. Use "Closes #N" if applicable. -->

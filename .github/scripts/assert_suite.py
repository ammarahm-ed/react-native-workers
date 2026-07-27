#!/usr/bin/env python3
"""Assert an in-app RNWORKERS-RESULTS line, shared by the Android and iOS e2e jobs.

    assert_suite.py <result-line> <native-crash-count>

Three independent checks, because any one alone misses real bugs:

  * passed != total from the header
  * any entry with "p":false  (reported by name, with detail)
  * any native crash marker AT ALL, even when every test passed — teardown is
    where worker bugs surface, and the JNI class-loader abort found while
    building this would have slipped through a tests-only assertion.

The header count is authoritative. Platform logs truncate long lines, so the
JSON array is usually cut off mid-entry; parsed entries only ADD failure detail
and are never used to derive the totals.
"""
import re
import sys

line = sys.argv[1] if len(sys.argv) > 1 else ""
crashes = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else 0

m = re.search(r"RNWORKERS-RESULTS\]\s+(\d+)/(\d+)", line)
if not m:
    print("::error::could not parse the results header")
    sys.exit(1)
passed, total = int(m.group(1)), int(m.group(2))

entries = re.findall(r'\{"n":"(.*?)","p":(true|false)(?:,"d":"(.*?)")?', line)
failures = [(n, d) for n, p, d in entries if p == "false"]

print(f"suite: {passed}/{total} passed  ({len(entries)} entries parsed from the log)")
for n, d in failures:
    print(f"::error::FAILED {n} — {d or 'no detail'}")

if crashes:
    print(f"::error::{crashes} native crash marker(s) in the device log")

if passed != total or failures or crashes:
    sys.exit(1)
print("All tests passed with no native crashes.")

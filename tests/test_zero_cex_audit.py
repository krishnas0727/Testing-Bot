import os
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PROHIBITED_KEYWORDS = [
    "binance",
    "bybit",
    "kucoin",
    "kraken",
    "coinbase",
    "ccxt",
]


class ZeroCEXAuditTest(unittest.TestCase):
    def test_zero_cex_references_in_codebase(self):
        """Verify that absolutely no centralized exchange references or libraries remain."""
        violations = []
        scanned_files = 0

        # Extensions to audit
        target_exts = {".py", ".html", ".js", ".css", ".md", ".txt", ".json", ".example"}

        for root, dirs, files in os.walk(ROOT):
            # Skip caches, git, and virtual environment
            dirs[:] = [d for d in dirs if d not in ("__pycache__", ".git", ".pytest_cache", "data", ".venv")]

            for file in files:
                if file == "test_zero_cex_audit.py":
                    continue
                ext = Path(file).suffix.lower()

                if file.startswith(".env") or ext in target_exts or file in ("Dockerfile", "Procfile"):
                    filepath = Path(root) / file
                    scanned_files += 1

                    try:
                        content = filepath.read_text(encoding="utf-8", errors="ignore")
                        lines = content.splitlines()
                        for line_no, line in enumerate(lines, 1):
                            for kw in PROHIBITED_KEYWORDS:
                                # Match whole words case-insensitively
                                if re.search(r"\b" + kw + r"\b", line, re.IGNORECASE):
                                    rel_path = filepath.relative_to(ROOT)
                                    violations.append(
                                        f"{rel_path}:{line_no} matches '{kw}': {line.strip()[:100]}"
                                    )
                    except Exception as e:
                        pass

        msg = f"\nFound {len(violations)} centralized exchange references across scanned files:\n" + "\n".join(violations)
        self.assertEqual(len(violations), 0, msg)
        self.assertGreater(scanned_files, 15)


if __name__ == "__main__":
    unittest.main()

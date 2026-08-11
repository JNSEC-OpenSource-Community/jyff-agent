#!/usr/bin/env python3
"""Run bounded, static-first reverse-engineering triage and emit a JSON manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass(frozen=True)
class Analysis:
    name: str
    command: Callable[[Path, Path], list[str]]
    output: str
    json_output: bool = False
    heavy: bool = False
    enabled: Callable[[Path], bool] = lambda _target: True


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def has_magic(path: Path, magic: bytes) -> bool:
    with path.open("rb") as stream:
        return stream.read(len(magic)) == magic


def run_analysis(
    analysis: Analysis,
    target: Path,
    output_dir: Path,
    timeout_seconds: int,
) -> dict[str, object]:
    command = analysis.command(target, output_dir)
    stdout_path = output_dir / analysis.output
    stderr_path = output_dir / f"{analysis.name}.stderr.txt"
    started = time.monotonic()
    result: dict[str, object] = {
        "command": shlex.join(command),
        "stdout": stdout_path.name,
        "stderr": stderr_path.name,
    }

    try:
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                cwd=output_dir,
                env={**os.environ, "NO_COLOR": "1", "RZ_COLOR": "0"},
                start_new_session=True,
            )
            try:
                returncode = process.wait(timeout=timeout_seconds)
                result["returncode"] = returncode
                result["status"] = "ok" if returncode == 0 else "failed"
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL) # pyright: ignore[reportAttributeAccessIssue]
                except ProcessLookupError:
                    pass
                process.wait()
                result["returncode"] = process.returncode
                result["status"] = "timed_out"
    except FileNotFoundError as error:
        stdout_path.touch()
        stderr_path.write_text(f"{error}\n", encoding="utf-8")
        result["returncode"] = None
        result["status"] = "unavailable"

    result["duration_ms"] = round((time.monotonic() - started) * 1000)
    result["stdout_bytes"] = stdout_path.stat().st_size
    result["stderr_bytes"] = stderr_path.stat().st_size

    if analysis.json_output and result["status"] == "ok":
        try:
            with stdout_path.open("r", encoding="utf-8") as stream:
                json.load(stream)
            result["json_valid"] = True
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            result["json_valid"] = False
            result["status"] = "invalid_json"
            result["json_error"] = str(error)

    return result


def analyses(symbol: str) -> list[Analysis]:
    rizin_base = [
        "rizin",
        "-qq",
        "-N",
        "-e",
        "scr.color=0",
        "-e",
        "scr.interactive=false",
        "-A",
    ]
    return [
        Analysis(
            "file", lambda target, _out: ["file", "-b", "--", str(target)], "file.txt"
        ),
        Analysis(
            "checksec",
            lambda target, _out: [
                "/usr/bin/checksec",
                "--output=json",
                f"--file={target}",
            ],
            "checksec.json",
            json_output=True,
            enabled=lambda target: has_magic(target, b"\x7fELF"),
        ),
        Analysis(
            "rz_info",
            lambda target, _out: ["rz-bin", "-Ij", str(target)],
            "rz-info.json",
            json_output=True,
        ),
        Analysis(
            "rz_strings",
            lambda target, _out: [
                "rizin",
                "-qq",
                "-N",
                "-e",
                "scr.color=0",
                "-e",
                "scr.interactive=false",
                "-c",
                "izzj",
                str(target),
            ],
            "rz-strings.json",
            json_output=True,
        ),
        Analysis(
            "rz_functions",
            lambda target, _out: [*rizin_base, "-c", "aflj", str(target)],
            "rz-functions.json",
            json_output=True,
        ),
        Analysis(
            "rz_ghidra",
            lambda target, _out: [*rizin_base, "-c", f"pdgj @ {symbol}", str(target)],
            f"rz-ghidra-{symbol}.json",
            json_output=True,
            heavy=True,
        ),
        Analysis(
            "strings",
            lambda target, _out: ["strings", "-a", "-n", "4", "--", str(target)],
            "strings.txt",
        ),
        Analysis(
            "binwalk",
            lambda target, out: [
                "binwalk",
                "--csv",
                f"--log={out / 'binwalk.csv'}",
                str(target),
            ],
            "binwalk.txt",
        ),
        Analysis(
            "capa",
            lambda target, _out: ["capa", "-j", str(target)],
            "capa.json",
            json_output=True,
            heavy=True,
        ),
        Analysis(
            "floss",
            lambda target, _out: ["floss", "-j", str(target)],
            "floss.json",
            json_output=True,
            heavy=True,
            enabled=lambda target: has_magic(target, b"MZ"),
        ),
        Analysis(
            "pycdc",
            lambda target, _out: ["pycdc", str(target)],
            "pycdc.py",
            enabled=lambda target: target.suffix.lower() == ".pyc",
        ),
        Analysis(
            "wasm",
            lambda target, _out: ["wasm-objdump", "-x", str(target)],
            "wasm.txt",
            enabled=lambda target: target.suffix.lower() == ".wasm",
        ),
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Static RE pre-analysis with per-tool timeouts and machine-readable results."
    )
    parser.add_argument(
        "target", type=Path, help="binary, bytecode, firmware, or WASM file"
    )
    parser.add_argument("-o", "--output", type=Path, help="output directory")
    parser.add_argument(
        "--timeout",
        type=int,
        default=180,
        help="timeout for each analyzer in seconds (default: 180)",
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="skip the slower capa, FLOSS, and Ghidra decompiler passes",
    )
    parser.add_argument(
        "--symbol",
        default="main",
        help="symbol passed to rz-ghidra for decompilation (default: main)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.timeout < 1:
        raise SystemExit("--timeout must be at least 1 second")
    if not re.fullmatch(r"[A-Za-z0-9_.$:+-]+", args.symbol):
        raise SystemExit("--symbol must be a simple Rizin symbol name or address")

    target = args.target.expanduser().resolve(strict=True)
    if not target.is_file():
        raise SystemExit(f"target is not a regular file: {target}")

    output_dir = (
        (args.output or Path.cwd() / f"{target.name}.re-preflight")
        .expanduser()
        .resolve()
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    configured_analyses = analyses(args.symbol)
    reserved_outputs = {output_dir / "summary.json", output_dir / "binwalk.csv"}
    for analysis in configured_analyses:
        reserved_outputs.add(output_dir / analysis.output)
        reserved_outputs.add(output_dir / f"{analysis.name}.stderr.txt")
    if target in reserved_outputs:
        raise SystemExit("target path collides with a pre-analysis output file")

    manifest: dict[str, object] = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "target": str(target),
        "size": target.stat().st_size,
        "sha256": sha256_file(target),
        "timeout_seconds": args.timeout,
        "quick": args.quick,
        "analyses": {},
    }
    results = manifest["analyses"]
    assert isinstance(results, dict)

    for analysis in configured_analyses:
        if not analysis.enabled(target):
            results[analysis.name] = {"status": "not_applicable"}
            continue
        if args.quick and analysis.heavy:
            results[analysis.name] = {"status": "skipped_quick_mode"}
            continue
        results[analysis.name] = run_analysis(
            analysis, target, output_dir, args.timeout
        )

    counts: dict[str, int] = {}
    for result in results.values():
        assert isinstance(result, dict)
        status = str(result["status"])
        counts[status] = counts.get(status, 0) + 1
    manifest["counts"] = counts

    manifest_path = output_dir / "summary.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {"output": str(output_dir), "summary": str(manifest_path), "counts": counts}
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

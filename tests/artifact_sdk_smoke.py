"""Verify artifact versions, aliases and uncached downloads with the real SDK."""
import json
import os
from pathlib import Path
import tempfile
import urllib.parse
import uuid

import wandb


def main():
    base = os.environ.get("RANDL_URL", "http://127.0.0.1:8742").rstrip("/")
    if urllib.parse.urlsplit(base).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Artifact smoke tests require a loopback RANDL_URL")
    os.environ["WANDB_BASE_URL"] = base
    os.environ["WANDB_API_KEY"] = os.environ.get("RANDL_API_KEY") or "0" * 40
    os.environ["WANDB_MODE"] = "online"
    suffix = uuid.uuid4().hex[:12]
    project = "artifact-sdk-" + suffix
    other_project = "artifact-other-" + suffix
    collection = "dataset-" + suffix
    payloads = [
        bytes(range(256)) + b"\x00version-zero\xff",
        bytes(reversed(range(256))) + b"\x00version-one\xfe",
        b"different project\x00\xff\n" + bytes(range(128)),
    ]
    text_bytes = '{\n  "message": "exact bytes: \u4f60\u597d",\n  "value": 1\n}\n'.encode("utf-8")

    with tempfile.TemporaryDirectory(prefix="randl-artifact-sdk-") as directory:
        root = Path(directory)
        os.environ["WANDB_DIR"] = directory
        os.environ["WANDB_CACHE_DIR"] = str(root / "cache")
        os.environ["WANDB_DATA_DIR"] = str(root / "staging")
        os.environ["WANDB_ARTIFACT_DIR"] = str(root / "artifacts")
        settings = wandb.Settings(init_timeout=20)

        def start(target_project, label):
            return wandb.init(
                entity="local", project=target_project,
                id=label + "-" + suffix, dir=directory, settings=settings, resume="never",
            )

        def publish(run, index, aliases, label):
            source = root / label
            source.mkdir()
            (source / "payload.bin").write_bytes(payloads[index])
            (source / "readme.json").write_bytes(text_bytes)
            artifact = wandb.Artifact(
                collection, type="dataset", description="SDK artifact verification",
                metadata={"revision": index, "format": "binary"},
            )
            artifact.add_file(str(source / "payload.bin"), name="nested/payload.bin")
            artifact.add_file(str(source / "readme.json"), name="readme.json")
            saved = run.log_artifact(artifact, aliases=aliases).wait(timeout=45)
            assert saved.id, "Committed artifact must have an ID"
            assert saved.state == "COMMITTED", saved.state
            assert saved.type == "dataset", saved.type
            assert saved.metadata == {"revision": index, "format": "binary"}, saved.metadata
            assert set(aliases).issubset(saved.aliases), saved.aliases
            return saved

        producer = start(project, "producer")
        first = publish(producer, 0, ["latest", "baseline"], "source-v0")
        assert first.version == "v0", first.version
        second = publish(producer, 1, ["latest", "candidate"], "source-v1")
        assert second.version == "v1", second.version
        assert first.id != second.id, "Changed artifact contents need a new version"
        duplicate = publish(producer, 1, ["stable"], "source-duplicate")
        assert duplicate.id == second.id, "Identical contents should reuse the existing version"
        assert duplicate.version == "v1", duplicate.version
        producer.finish()

        other_producer = start(other_project, "other-producer")
        other = publish(other_producer, 2, ["latest"], "source-other")
        assert other.version == "v0", "Version numbering must be scoped to the project"
        assert other.id not in {first.id, second.id}, "Projects must have distinct artifacts"
        other_producer.finish()

        consumer = start(project, "consumer")
        cases = [
            (project, "baseline", first.id, "v0", 0),
            (project, "v0", first.id, "v0", 0),
            (project, "latest", second.id, "v1", 1),
            (project, "stable", second.id, "v1", 1),
            (other_project, "latest", other.id, "v0", 2),
        ]
        for index, (target_project, alias, expected_id, version, payload_index) in enumerate(cases):
            used = consumer.use_artifact(
                f"local/{target_project}/{collection}:{alias}", type="dataset",
            )
            assert used.id == expected_id, (target_project, alias, used.id, expected_id)
            assert used.version == version, (alias, used.version)
            assert used.project == target_project, used.project
            destination = root / ("download-" + str(index))
            downloaded = Path(used.download(root=str(destination), skip_cache=True))
            files = {p.relative_to(downloaded).as_posix() for p in downloaded.rglob("*") if p.is_file()}
            assert files == {"nested/payload.bin", "readme.json"}, files
            assert (downloaded / "nested/payload.bin").read_bytes() == payloads[payload_index], alias
            assert (downloaded / "readme.json").read_bytes() == text_bytes, alias
        consumer.finish()
        wandb.teardown()

    print(json.dumps({
        "sdk": wandb.__version__, "artifact_versions": ["v0", "v1"],
        "aliases": ["baseline", "latest", "stable", "v0"],
        "deduplication": "passed", "project_isolation": "passed",
        "uncached_downloads": len(cases), "exact_file_comparisons": len(cases) * 2,
    }))


if __name__ == "__main__":
    main()

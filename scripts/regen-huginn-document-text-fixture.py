"""Recompute src/summaries/__fixtures__/huginn-document-text.json from huginn.

The fixture's INPUTS are its own; this script only rewrites each `expected` with
huginn's answer, so the image filter in src/summaries/source-text.ts is checked
against huginn itself rather than against a reading of its code.

    <huginn>/.venv/bin/python scripts/regen-huginn-document-text-fixture.py <huginn> [extra-inputs.json]

`extra-inputs.json` is optional: `{"images": [...], "texts": [...]}` appended to
the fixture's inputs (duplicates skipped).
"""

import json
import sys
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent.parent / "src/summaries/__fixtures__/huginn-document-text.json"


def main() -> None:
    huginn = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(huginn))
    from main.sources.files.files_document_converter import FilesDocumentConverter as C

    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    images = [case["input"] for case in fixture["images"]]
    texts = [case["input"] for case in fixture["texts"]]
    if len(sys.argv) > 2:
        extra = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
        images += [s for s in extra.get("images", []) if s not in images]
        texts += [s for s in extra.get("texts", []) if s not in texts]

    def whole(text: str) -> str:
        # The image + S3 half of _clean_document_text; fence removal left out.
        text = C._MD_IMAGE_RE.sub(lambda m: C._document_text_image(m.group(0)) or "", text)
        return C._S3_URL_RE.sub("[file]", text)

    fixture["images"] = [{"input": s, "expected": C._document_text_image(s)} for s in images]
    fixture["texts"] = [{"input": t, "expected": whole(t)} for t in texts]
    FIXTURE.write_text(json.dumps(fixture, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(images)} images, {len(texts)} texts -> {FIXTURE}")


if __name__ == "__main__":
    main()

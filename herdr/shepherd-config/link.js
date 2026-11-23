// Terminal link handler for shepherd markdown artifacts (_plans/*.md and reports/review*.md).
import { openOverlay } from "herdr";

const SHEPHERD_DOC = /(?:^|\/)(?:\.shepherd\/(?:tasks\/[^/]+\/)?reports\/review[^\s]*\.md|_plans\/[^\s]+\.md)$/;
const HAS_TRAVERSAL = /(?:^|\/)\.\.(?:\/|$)/;

export function handleLink(click) {
  if (!click || click.link?.kind !== "file") return "pass";
  const target = click.link.path || click.link.raw || "";
  if (!target || HAS_TRAVERSAL.test(target) || !SHEPHERD_DOC.test(target)) return "pass";
  const fullPath = target.startsWith("/") || !click.source?.cwd ? target : `${click.source.cwd.replace(/\/+$/, "")}/${target}`;
  openOverlay({
    kind: "window",
    mod: "shepherd-viewer",
    key: "shepherd-viewer",
    props: { file: fullPath, on: click.source?.machine ?? null },
    width: 780,
    height: 640,
  });
  return "handled";
}

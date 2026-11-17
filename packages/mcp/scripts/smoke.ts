/*
 * dist/index.js 스크립트 없이 로컬에서 돌리는 JSON-RPC 연기 테스트.
 * bun run smoke(build 후 실행)가 이 스크립트를 돌려요.
 * 검증: initialize 핸드셰이크 → tools/list(도구 4종) → 도구 4종 실제 호출.
 * 전부 통과하면 0으로 종료, 하나라도 어긋나면 1로 실패해요.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const EXPECTED_TOOLS = [
  "search_items",
  "view_item",
  "get_install_command",
  "get_docs",
];

type Response = {
  id?: number | string;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    tools?: Array<{ name: string }>;
    isError?: boolean;
  };
  error?: { message?: string };
};

const proc = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map<number, (response: Response) => void>();
let nextId = 1;

proc.stdout.on("error", () => {});
const reader = createInterface({ input: proc.stdout });
reader.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line) as Response;
    if (message.id !== undefined) {
      const resolve = pending.get(message.id as number);
      if (resolve) {
        pending.delete(message.id as number);
        resolve(message);
      }
    }
  } catch {
    // 프로토콜 외 라인은 무시
  }
});

function request(method: string, params?: unknown): Promise<Response> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 응답 시간 초과`));
      }
    }, 10_000).unref();
  });
}

function notify(method: string): void {
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
}

function textOf(response: Response): string {
  return (response.result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok — ${label}`);
  } else {
    failures += 1;
    console.error(`  실패 — ${label}${detail ? `: ${detail}` : ""}`);
  }
}

async function main() {
  const timer = setTimeout(() => {
    console.error("smoke 전체 시간 초과(30초) — 서버를 강제 종료해요.");
    proc.kill();
    process.exit(1);
  }, 30_000);
  timer.unref();

  // bin 배포 형태 — shebang이 없으면 npx가 셸 폴백으로 실패해요(사이클 100 리뷰).
  const firstLine = readFileSync("dist/index.js", "utf8").split("\n", 1)[0];
  check(
    "dist — bin shebang(#!/usr/bin/env node)",
    firstLine.startsWith("#!/usr/bin/env node"),
    firstLine,
  );
  try {
    accessSync("dist/index.js", constants.X_OK);
    check("dist — 실행 권한", true);
  } catch {
    check("dist — 실행 권한", false);
  }

  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "unikit-smoke", version: "0.0.0" },
  });
  check("initialize 응답", init.result !== undefined, init.error?.message);
  notify("notifications/initialized");

  const listed = await request("tools/list");
  const toolNames = (listed.result?.tools ?? []).map((tool) => tool.name);
  check(
    `tools/list — 도구 4종(${EXPECTED_TOOLS.join(", ")})`,
    EXPECTED_TOOLS.every((tool) => toolNames.includes(tool)),
    `수신: ${toolNames.join(", ")}`,
  );

  const search = await request("tools/call", {
    name: "search_items",
    arguments: { query: "button" },
  });
  const searchText = textOf(search);
  check("search_items — button 검색", searchText.includes("- button"), searchText.slice(0, 120));

  const view = await request("tools/call", {
    name: "view_item",
    arguments: { name: "button" },
  });
  const viewText = textOf(view);
  check(
    "view_item — button 소스 전문",
    viewText.includes("## button") && viewText.includes("cva("),
    viewText.slice(0, 120),
  );
  check(
    "view_item — button 사용법 발췌(전용 섹션 전문)",
    viewText.includes("사용법 (docs/components.md 발췌)") &&
      viewText.includes("variant"),
  );

  const dialogView = await request("tools/call", {
    name: "view_item",
    arguments: { name: "dialog" },
  });
  check(
    "view_item — dialog 사용법 발췌(배치 표 행)",
    textOf(dialogView).includes("중앙 모달"),
  );

  const notFound = await request("tools/call", {
    name: "view_item",
    arguments: { name: "no-such-item" },
  });
  check(
    "view_item — 없는 아이템 isError",
    notFound.result?.isError === true && notFound.result?.content?.[0] !== undefined,
  );

  const proto = await request("tools/call", {
    name: "view_item",
    arguments: { name: "__proto__" },
  });
  check(
    "view_item — 프로토타입 키 차단",
    proto.result?.isError === true && !textOf(proto).includes("## undefined"),
  );

  const themeView = await request("tools/call", {
    name: "view_item",
    arguments: { name: "theme" },
  });
  check(
    "view_item — theme cssVars 본문 출력",
    textOf(themeView).includes("cssVars") && textOf(themeView).includes("--background"),
  );

  const install = await request("tools/call", {
    name: "get_install_command",
    arguments: { names: ["button", "dialog"] },
  });
  const installText = textOf(install);
  check(
    "get_install_command — 두 모드 생성",
    installText.includes("bun add") &&
      installText.includes("https://ui.ll3.kr/r/button.json") &&
      installText.includes("https://ui.ll3.kr/r/dialog.json"),
    installText.slice(0, 160),
  );

  const tokenInstall = await request("tools/call", {
    name: "get_install_command",
    arguments: { names: ["theme"] },
  });
  check(
    "get_install_command — 의존성 없는 아이템은 빈 bun add를 내지 않음",
    !textOf(tokenInstall).includes("bun add"),
  );

  const overview = await request("tools/call", {
    name: "get_docs",
    arguments: {},
  });
  const overviewText = textOf(overview);
  check(
    "get_docs — 제품군 개요",
    ["unikit-ui", "rustra", "scriptca"].every((id) =>
      overviewText.includes(id),
    ) && overviewText.includes("product"),
    overviewText.slice(0, 160),
  );

  const docs = await request("tools/call", {
    name: "get_docs",
    arguments: { product: "unikit-ui" },
  });
  const docsText = textOf(docs);
  check(
    "get_docs — unikit-ui llms.txt 전문",
    docsText.includes("UniKit UI") && docsText.length > 1000,
    `길이 ${docsText.length}`,
  );

  const rustraDocs = await request("tools/call", {
    name: "get_docs",
    arguments: { product: "rustra" },
  });
  const rustraText = textOf(rustraDocs);
  check(
    "get_docs — rustra llms.txt 전문",
    rustraText.includes("# rustra") && rustraText.length > 1000,
    `길이 ${rustraText.length}`,
  );

  const scriptcaDocs = await request("tools/call", {
    name: "get_docs",
    arguments: { product: "scriptca" },
  });
  const scriptcaText = textOf(scriptcaDocs);
  check(
    "get_docs — scriptca llms.txt 전문",
    scriptcaText.includes("# scriptca") && scriptcaText.length > 1000,
    `길이 ${scriptcaText.length}`,
  );

  check(
    "get_docs — 제품군 개요에 문서 있음 표기",
    !overviewText.includes("llms.txt 준비 중"),
  );

  const noProduct = await request("tools/call", {
    name: "get_docs",
    arguments: { product: "no-such" },
  });
  check("get_docs — 없는 제품 isError", noProduct.result?.isError === true);

  clearTimeout(timer);
  proc.kill();
  if (failures > 0) {
    console.error(`smoke 실패 — ${failures}건 어긋남`);
    process.exit(1);
  }
  console.log("smoke 통과 — 도구 4종 정상 동작");
}

main().catch((error) => {
  console.error(error);
  proc.kill();
  process.exit(1);
});

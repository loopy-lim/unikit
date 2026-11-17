#!/usr/bin/env node
/*
 * @unikit-bridge/mcp — unikit-bridge 제품군 MCP 서버(stdio).
 *
 * 정적 데이터 번들 방식: UniKit UI 레지스트리 카탈로그·아이템 전문·제품별
 * llms.txt를 src/data.ts로 동봉해 런타임 네트워크 접근이 0이에요. 데이터는 npm
 * 게시 주기에 맞춰 갱신돼요(포털 저장소에서 bun run sync:data 재생성 ·
 * ui.ll3.kr/r/<name>.json과 동일 원천). 서버 소스는 제품군 포털 저장소
 * (github.com/loopy-lim/unikit)의 packages/mcp에 있어요.
 *
 * 도구 4종:
 *   search_items         — UniKit UI 레지스트리 이름·제목·설명 검색(빈 쿼리 = 전체)
 *   view_item            — 아이템 전문(files[].content 포함) + 설치 명령
 *   get_install_command  — npm 모드 · 소스 복사(shadcn CLI) 모드 설치 명령 생성
 *   get_docs             — 제품 문서(llms.txt) — product 생략 시 제품군 개요
 *
 * 주의: stdout은 JSON-RPC 전용 채널 — 진단 출력은 console.error만 쓴다.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  CATALOG_JSON,
  DOCS_JSON,
  ITEMS_JSON,
  PRODUCTS_JSON,
  SERVER_VERSION,
  SITE_ORIGIN,
  USAGE_JSON,
} from "./data";

type CatalogItem = {
  name: string;
  type?: string;
  title?: string;
  description?: string;
};

type RegistryFile = {
  path: string;
  target?: string;
  content?: string;
};

type RegistryItem = CatalogItem & {
  registryDependencies?: string[];
  dependencies?: string[];
  files?: RegistryFile[];
  /** theme 아이템의 토큰 값 — files 없이 이 키로만 전달돼요(실측: {light:{..},dark:{..}} 스킴 중첩) */
  cssVars?: Record<string, string | Record<string, string>>;
  /** style 아이템의 CSS — files 없이 이 키로만 전달돼요(실측: 셀렉터→선언 객체) */
  css?: string | Record<string, string | Record<string, string>>;
};

const catalog = JSON.parse(CATALOG_JSON) as { items?: CatalogItem[] };
const catalogItems: CatalogItem[] = catalog.items ?? [];
const items = JSON.parse(ITEMS_JSON) as Record<string, RegistryItem>;
/** docs/components.md에서 뽑은 컴포넌트별 사용법 조각(이름 → 발췌) */
const usage = JSON.parse(USAGE_JSON) as Record<string, string>;

/** 제품군 카탈로그(포털 site.ts PROJECTS에서 유도) */
type ProductInfo = {
  id: string;
  name: string;
  tagline: string;
  site?: string;
  repo: string;
  packages: Array<{ name: string; registry: string }>;
  docsAvailable: boolean;
};
const products = JSON.parse(PRODUCTS_JSON) as ProductInfo[];
const productDocs = JSON.parse(DOCS_JSON) as Record<string, string>;

const HINT =
  "팁: view_item(name)으로 소스 전문·컴포넌트별 사용법, get_install_command({names:[...]})으로 설치 명령, get_docs({product:\"unikit-ui\"})로 사용 규칙 전체를 볼 수 있어요.";

function itemUrl(name: string): string {
  return `${SITE_ORIGIN}/r/${name}.json`;
}

/** 카탈로그 한 줄 요약 — 검색·목록 공용 */
function catalogLine(item: CatalogItem): string {
  const title = item.title ? `${item.title}: ` : "";
  const type = item.type ? ` (${item.type})` : "";
  return `- ${item.name}${type} — ${title}${item.description ?? ""}`;
}

const server = new McpServer({ name: "unikit-bridge", version: SERVER_VERSION });

// --- search_items ------------------------------------------------------------
server.tool(
  "search_items",
  `UniKit UI 레지스트리에서 컴포넌트·블록·테마 항목을 검색합니다(웹+React Native 단일 소스, 전체 ${catalogItems.length}종). 빈 쿼리면 전체 목록을 돌려줍니다.`,
  { query: z.string().optional().describe("검색어 — 이름·제목·설명과 대소문자 무시 매칭") },
  async ({ query }) => {
    const q = (query ?? "").trim().toLowerCase();
    const matched = q
      ? catalogItems.filter((item) =>
          [item.name, item.title, item.description, item.type]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
      : catalogItems;
    const header = q
      ? `검색 "${query}" — ${matched.length}건 / 전체 ${catalogItems.length}종`
      : `UniKit UI 레지스트리 전체 ${catalogItems.length}종`;
    const body = matched.map(catalogLine).join("\n");
    return { content: [{ type: "text", text: `${header}\n${body}\n\n${HINT}` }] };
  },
);

// --- view_item ---------------------------------------------------------------
server.tool(
  "view_item",
  "레지스트리 아이템 하나의 전문을 돌려줍니다 — 메타데이터(의존성·파일 대상 경로), docs/components.md에서 뽑은 그 컴포넌트의 사용법(props·예시), 소스 전문(files[].content), theme 아이템의 cssVars·style 아이템의 CSS까지 포함.",
  { name: z.string().describe("아이템 name — 예: button, dialog, overlay") },
  async ({ name }) => {
    const item = Object.hasOwn(items, name) ? items[name] : undefined;
    if (!item) {
      const q = name.toLowerCase();
      const suggestions = catalogItems
        .filter((candidate) => candidate.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map((candidate) => candidate.name);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `아이템 "${name}"이(가) 없어요. 전체 ${catalogItems.length}종이에요.${
              suggestions.length ? ` 비슷한 이름: ${suggestions.join(", ")}` : ""
            }`,
          },
        ],
      };
    }
    const lines: string[] = [];
    lines.push(`## ${item.name}${item.type ? ` (${item.type})` : ""}`);
    if (item.title || item.description) {
      lines.push(`${item.title ?? ""}${item.title && item.description ? ": " : ""}${item.description ?? ""}`);
    }
    if (item.registryDependencies?.length) {
      lines.push(`registryDependencies: ${item.registryDependencies.join(", ")}`);
    }
    if (item.dependencies?.length) {
      lines.push(`dependencies: ${item.dependencies.join(", ")}`);
    }
    if (item.files?.length) {
      lines.push(`files: ${item.files.map((file) => file.target ?? file.path).join(", ")}`);
    }
    lines.push(`설치(소스 복사): bunx shadcn@latest add ${itemUrl(item.name)} -y`);
    if (Object.hasOwn(usage, name)) {
      lines.push("\n--- 사용법 (docs/components.md 발췌) ---");
      lines.push(usage[name]);
    }
    for (const file of item.files ?? []) {
      lines.push(`\n--- ${file.target ?? file.path} ---`);
      lines.push("```tsx");
      lines.push(file.content ?? "(content 없음)");
      lines.push("```");
    }
    if (item.cssVars) {
      lines.push("\n--- cssVars ---", "```css");
      for (const [key, value] of Object.entries(item.cssVars)) {
        if (typeof value === "string") {
          lines.push(`${key}: ${value};`);
        } else {
          lines.push(`/* ${key} */`);
          for (const [token, tokenValue] of Object.entries(value)) {
            lines.push(`${token}: ${tokenValue};`);
          }
        }
      }
      lines.push("```");
    }
    if (typeof item.css === "string") {
      lines.push("\n--- css ---", "```css", item.css, "```");
    } else if (item.css) {
      lines.push("\n--- css ---", "```css");
      for (const [selector, declarations] of Object.entries(item.css)) {
        if (typeof declarations === "string") {
          lines.push(`${selector}: ${declarations};`);
        } else {
          lines.push(`${selector} {`);
          for (const [property, value] of Object.entries(declarations)) {
            lines.push(`  ${property}: ${value};`);
          }
          lines.push("}");
        }
      }
      lines.push("```");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// --- get_install_command -----------------------------------------------------
server.tool(
  "get_install_command",
  "아이템 설치 명령을 생성합니다 — npm 모드(패키지 의존성 설치)와 소스 복사 모드(shadcn CLI로 프로젝트에 복사) 두 가지를 모두 돌려줍니다.",
  {
    names: z
      .array(z.string())
      .min(1)
      .describe("아이템 name 목록 — 예: [\"button\", \"dialog\"]"),
  },
  async ({ names }) => {
    const unknown = names.filter((name) => !Object.hasOwn(items, name));
    if (unknown.length) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `없는 아이템이 포함돼 있어요: ${unknown.join(", ")}. search_items로 확인해 주세요.`,
          },
        ],
      };
    }
    const deps = [
      ...new Set(names.flatMap((name) => items[name].dependencies ?? [])),
    ].sort();
    const urls = names.map(itemUrl).join(" ");
    const text = [
      ...(deps.length
        ? [
            "## npm 모드 — 패키지 그대로 소비(권장 시작점)",
            "```sh",
            `bun add ${deps.join(" ")}`,
            "```",
            "컴포넌트는 `@unikit-bridge/ui` 배럴에서 import해요. chart는 `@unikit-bridge/ui/chart`, 마크다운 에디터는 `@unikit-bridge/ui/editor` 진입점이에요(선택 peer).",
          ]
        : [
            "## npm 모드",
            "선택한 아이템에는 추가 npm 의존성이 없어요(토큰·스타일·lib 아이템) — 소스 복사 모드로 소비해요.",
          ]),
      "",
      "## 소스 복사 모드 — shadcn CLI로 프로젝트에 복사",
      "```sh",
      `bunx shadcn@latest add ${urls} -y`,
      "```",
      "복사본은 components/unikit/ 아래로 들어가요. 토큰 규칙·한계는 get_docs()에서 확인해요.",
    ].join("\n");
    return { content: [{ type: "text", text }] };
  },
);

// --- get_docs ----------------------------------------------------------------
server.tool(
  "get_docs",
  "제품 문서(llms.txt)를 돌려줍니다. product를 생략하면 unikit-bridge 제품군 개요를, \"unikit-ui\"·\"rustra\"·\"scriptca\"를 지정하면 각 제품 전문(사용 규칙·아키텍처·주의점)을 돌려줍니다. 해당 제품 코드를 작성·수정하기 전에 읽으세요.",
  {
    product: z
      .string()
      .optional()
      .describe("제품 id — unikit-ui · rustra · scriptca. 생략하면 제품군 개요"),
  },
  async ({ product }) => {
    if (!product) {
      const lines = ["## unikit-bridge 제품군", ""];
      for (const p of products) {
        const docsState = p.docsAvailable ? "문서 있음" : "llms.txt 준비 중";
        const pkgs = p.packages.map((ref) => ref.name).join(", ");
        lines.push(
          `- ${p.id}(${p.name}) — ${p.tagline} · 패키지: ${pkgs} · ${docsState}${p.site ? ` · ${p.site}` : ""}`,
        );
      }
      lines.push(
        "",
        `전문은 get_docs({ product: "unikit-ui" })처럼 제품을 지정해 읽어요. UI 레지스트리 도구(search_items·view_item·get_install_command)는 unikit-ui 대상이에요.`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    const known = products.find((p) => p.id === product || p.name === product);
    if (!known) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `제품 "${product}"이(가) 없어요. 사용 가능: ${products
              .map((p) => p.id)
              .join(", ")}`,
          },
        ],
      };
    }
    const doc = Object.hasOwn(productDocs, known.id)
      ? productDocs[known.id]
      : undefined;
    if (!doc) {
      return {
        content: [
          {
            type: "text",
            text: `${known.name}(${known.id})의 llms.txt는 아직 준비 전이에요 — ${known.repo} 저장소를 직접 확인해 주세요.`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text: doc }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `unikit-bridge MCP 서버 기동 — 제품 ${products.length}종 · UI 아이템 ${catalogItems.length}종 동봉(버전 ${SERVER_VERSION})`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

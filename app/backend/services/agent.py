"""Agent service: intent judgement, planning, per-file code generation and summaries."""

import asyncio
import json
import logging
import os
import re
from typing import Any, Awaitable, Callable

from fastapi import HTTPException
from openai import AsyncOpenAI
from schemas.aihub import ChatMessage, GenTxtRequest
from services.aihub import AIHubService

logger = logging.getLogger(__name__)

PRIMARY_MODEL = "claude-opus-5"
FALLBACK_MODEL = "deepseek-v4-pro"
MODEL_TIMEOUT_SECONDS = 90
FILE_PATHS = ["server.js", "index.html", "app.js"]
FIELD_TYPES = {"text", "number", "boolean", "date"}
RESERVED_FIELDS = {"id", "createdAt", "updatedAt", "requestId"}
DEFAULT_MAX_LENGTH = 200
MAX_FILE_LINES = 500

FILE_PURPOSES = {
    "server.js": "数据服务：处理 4 条 CRUD 接口，通过 store 读写持久化数据，数据缺失或损坏时自动重建",
    "index.html": "页面结构与样式：表单、列表、空状态、错误提示，引用 app.js",
    "app.js": "前端逻辑：调用数据接口完成新增、查看、修改、删除，并即时刷新列表",
}

API_CONTRACT = [
    {"method": "GET", "path": "/api/items", "desc": "列出全部记录 → 200 {items: Item[]}（新的在前）"},
    {"method": "POST", "path": "/api/items", "desc": "新增记录，body 含 requestId 去重 → 201 Item；重复 requestId → 200 已有记录；校验失败 → 400 {error}"},
    {"method": "PUT", "path": "/api/items/:id", "desc": "按 id 局部修改 → 200 Item；不存在 → 404 {error}"},
    {"method": "DELETE", "path": "/api/items/:id", "desc": "按 id 删除 → 200 {deleted: true, id}；不存在 → 404 {error}"},
]

RUNTIME_CONTRACT = """
运行环境约束（必须严格遵守）：
- 生成的应用零外部依赖：禁止 require、import、CDN、外部字体/图片、任何外网请求。
- 每个文件不超过 500 行。界面文案使用简体中文。

server.js（运行在隔离的应用实例中，没有 DOM、没有 Node API、没有网络）：
- 必须在顶层用函数声明定义：async function handle(req, store) { ... }
- req = { method: 'GET'|'POST'|'PUT'|'DELETE', path: '/api/items' 或 '/api/items/<id>', query: object, body: object|null }
- store.read() 返回 Promise<object|null>，store.write(obj) 返回 Promise<void>。这是唯一的持久化方式，禁止只把数据放在内存变量里。
- 数据结构固定为 { items: Item[] }。store.read() 返回 null 或结构不合法时，按 { items: [] } 重建，绝不能抛错。
- Item = { id: string, ...字段, requestId: string, createdAt: ISO 字符串, updatedAt: ISO 字符串 }。id 用时间戳+随机数生成字符串。
- 返回值必须是 { status: number, body: 可 JSON 序列化的值 }。
- 接口：
  GET /api/items → 200 { items }，按 createdAt 倒序。
  POST /api/items → 校验必填字段与文本长度上限，失败 400 { error }；若已存在相同 requestId 的记录，返回 200 和该记录（不得重复新增）；否则写入并返回 201 新记录。
  PUT /api/items/<id> → 只更新计划中声明的字段（同样校验长度），更新 updatedAt，返回 200 记录；不存在返回 404 { error: '记录不存在' }。
  DELETE /api/items/<id> → 200 { deleted: true, id }；不存在返回 404 { error: '记录不存在' }，不得抛错。
  其它路径 → 404 { error: '接口不存在' }。
- number 字段存数字，boolean 字段存布尔值，date 字段存 'YYYY-MM-DD' 字符串。

index.html：
- 完整 HTML 文档，样式写在内联 <style> 中，在 </body> 前用 <script src="app.js"></script> 引入脚本，不得有其它外部资源。
- 必须包含：新增表单（文本输入带 maxlength 并提示长度上限）、记录列表容器、空状态提示区域、错误提示区域。
- 长文本必须自动换行（overflow-wrap:anywhere），不得撑破布局。

app.js（浏览器脚本，原生 JS，不用任何框架）：
- 用 fetch('api/items', ...) 这样的相对路径和 JSON 请求调用接口（Content-Type: application/json）。
- 新增时为本次提交生成 requestId（crypto.randomUUID 可用则用，否则 Date.now()+随机数），提交过程中禁用按钮防止重复提交。
- 成功后立即重新拉取列表并渲染，无需手动刷新；空列表显示明确的空状态文案。
- 每条记录支持修改（boolean 字段可直接切换，文本等字段可编辑后保存）和删除。
- 请求失败时在错误区域显示原因。渲染文本时必须转义 HTML，避免注入。
- 禁止使用 localStorage/sessionStorage/IndexedDB 作为数据来源，数据只来自接口。

数据兼容（应用会被增量修改，必须遵守）：
- 记录中缺少计划声明的字段时视为空值：页面显示「—」，不得出现 undefined、null 字样或布局错位。
- 记录中存在但计划未声明的键必须原样保留：server.js 读取、PUT 合并时都不得删除或清理这些键。
- 计划中的 changes 是累计的修改要求，必须全部同时生效；removed 是已删除的字段，页面与脚本不得再引用它们。
""".strip()


def _error_detail(exc: Exception) -> str:
    text = str(exc) or exc.__class__.__name__
    return text[:500]


TRANSIENT_RETRIES = 2
BALANCE_MESSAGE = "AI 余额不足，模型调用被拒绝（不是代码问题）。请在 Atoms 设置中为 AI 余额充值后，点击「继续」重试。"


def _classify(exc: Exception) -> str:
    """Return 'balance', 'transient' or 'other' for an upstream model error."""
    text = str(exc).lower()
    status = getattr(exc, "status_code", None)
    if "balance is insufficient" in text or "insufficient" in text and "balance" in text or "quota" in text:
        return "balance"
    if status in (408, 409, 429, 500, 502, 503, 504) or any(
        k in text for k in ("timeout", "temporarily", "overloaded", "connection", "rate limit")
    ):
        return "transient"
    return "other"


DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_MAX_TOKENS = 8192
_deepseek_client: AsyncOpenAI | None = None


def _deepseek() -> AsyncOpenAI | None:
    """Return a DeepSeek client when DEEPSEEK_API_KEY is configured (Atoms Cloud > Keys)."""
    global _deepseek_client
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        return None
    if _deepseek_client is None or _deepseek_client.api_key != key:
        _deepseek_client = AsyncOpenAI(api_key=key, base_url=DEEPSEEK_BASE_URL, timeout=MODEL_TIMEOUT_SECONDS)
    return _deepseek_client


def _backends() -> list[tuple[str, Callable[[list[ChatMessage], int], Awaitable[str]]]]:
    """DeepSeek official API when its key is configured; otherwise the Atoms AI gateway."""
    client = _deepseek()
    if client is not None:

        async def via_deepseek(messages: list[ChatMessage], max_tokens: int) -> str:
            response = await client.chat.completions.create(
                model=DEEPSEEK_MODEL,
                messages=[{"role": m.role, "content": m.content} for m in messages],
                max_tokens=min(max_tokens, DEEPSEEK_MAX_TOKENS),
                temperature=0.3,
                stream=False,
            )
            return response.choices[0].message.content or ""

        return [(f"deepseek:{DEEPSEEK_MODEL}", via_deepseek)]

    service = AIHubService()

    def via_aihub(model: str):
        async def call(messages: list[ChatMessage], max_tokens: int) -> str:
            request = GenTxtRequest(messages=messages, model=model, max_tokens=max_tokens, temperature=0.3)
            return (await service.gentxt(request)).content or ""

        return call

    return [(f"atoms:{m}", via_aihub(m)) for m in (PRIMARY_MODEL, FALLBACK_MODEL)]


async def _call_model(messages: list[ChatMessage], max_tokens: int) -> str:
    """Call the configured model backend with backoff on transient errors.

    Insufficient balance or an invalid key fails fast with a clear message, because retrying
    cannot succeed and would only hide the real cause.
    """
    last_error: Exception | None = None
    for name, call in _backends():
        for attempt in range(TRANSIENT_RETRIES + 1):
            try:
                content = await asyncio.wait_for(call(messages, max_tokens), timeout=MODEL_TIMEOUT_SECONDS)
            except asyncio.TimeoutError as exc:
                raise HTTPException(status_code=504, detail="模型调用超过 90 秒，已中止本次调用") from exc
            except Exception as exc:
                kind = _classify(exc)
                logger.warning("Model %s failed (%s, attempt %d): %s", name, kind, attempt + 1, exc)
                if kind == "balance":
                    raise HTTPException(status_code=402, detail=BALANCE_MESSAGE.replace("Atoms 设置中为 AI 余额", "对应平台") if name.startswith("deepseek") else BALANCE_MESSAGE) from exc
                if getattr(exc, "status_code", None) == 401:
                    raise HTTPException(status_code=401, detail="DeepSeek API Key 无效或已失效，请在 Atoms Cloud > Keys 中更新 DEEPSEEK_API_KEY。") from exc
                last_error = exc
                if kind == "transient" and attempt < TRANSIENT_RETRIES:
                    await asyncio.sleep(1.5 * (2**attempt))
                    continue
                break
            if content.strip():
                return content
            last_error = ValueError("模型返回了空内容")
            break
    detail = _error_detail(last_error or Exception())
    if last_error is not None and _classify(last_error) == "transient":
        raise HTTPException(status_code=503, detail=f"模型服务暂时不可用（已自动重试），请稍后点击「继续」：{detail}")
    raise HTTPException(status_code=502, detail=f"模型调用失败：{detail}")


def _extract_json(text: str) -> str:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*\n(.*?)```", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    return text[start : end + 1] if start >= 0 and end > start else text


def _parse_object(text: str) -> dict:
    try:
        payload = json.loads(_extract_json(text))
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON 解析失败：{exc.msg}") from exc
    if not isinstance(payload, dict):
        raise ValueError("根节点必须是对象")
    return payload


async def _json_call(
    system: str, user: str, schema_hint: str, validate: Callable[[dict], dict], max_tokens: int = 3000
) -> dict:
    """Run a structured call; on invalid output run exactly one repair call."""
    raw = await _call_model(
        [ChatMessage(role="system", content=system), ChatMessage(role="user", content=user)], max_tokens
    )
    try:
        return validate(_parse_object(raw))
    except ValueError as first_error:
        repaired = await _call_model(
            [
                ChatMessage(role="system", content="只返回修正后的合法 JSON，不要任何解释。"),
                ChatMessage(
                    role="user",
                    content=f"期望结构：{schema_hint}\n校验错误：{first_error}\n原始输出：\n{raw[:6000]}",
                ),
            ],
            max_tokens,
        )
        try:
            return validate(_parse_object(repaired))
        except ValueError as exc:
            raise HTTPException(status_code=502, detail=f"模型返回结构不合法：{exc}") from exc


def _normalize_fields(raw_fields: Any, strict: bool) -> list[dict]:
    if not isinstance(raw_fields, list):
        raise ValueError("fields 必须是数组")
    fields: list[dict] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_fields):
        if not isinstance(raw, dict):
            raise ValueError(f"fields[{index}] 必须是对象")
        name = str(raw.get("name", "")).strip()
        if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,30}", name) or name in RESERVED_FIELDS or name in seen:
            if strict:
                raise ValueError(f"fields[{index}].name 不合法或重复：{name!r}")
            continue
        field_type = str(raw.get("type", "text")).lower()
        if field_type not in FIELD_TYPES:
            field_type = "text"
        label = str(raw.get("label") or name).strip()[:20]
        field: dict[str, Any] = {
            "name": name,
            "label": label,
            "type": field_type,
            "required": bool(raw.get("required", False)),
        }
        if field_type == "text":
            try:
                max_length = int(raw.get("max_length") or DEFAULT_MAX_LENGTH)
            except (TypeError, ValueError):
                max_length = DEFAULT_MAX_LENGTH
            field["max_length"] = max(10, min(max_length, 2000))
        seen.add(name)
        fields.append(field)
    if strict and not 1 <= len(fields) <= 8:
        raise ValueError("fields 数量必须在 1 到 8 之间")
    if strict and not any(f["type"] == "text" for f in fields):
        raise ValueError("至少需要一个 text 字段")
    return fields[:8]


def _validate_intent(payload: dict) -> dict:
    if not isinstance(payload.get("sufficient"), bool):
        raise ValueError("sufficient 必须是布尔值")
    options = payload.get("options") or []
    if not isinstance(options, list) or not all(isinstance(o, str) for o in options):
        raise ValueError("options 必须是字符串数组")
    options = [o.strip() for o in options if o.strip()][:3]
    question = str(payload.get("question") or "").strip()
    if not payload["sufficient"] and (not question or not options):
        raise ValueError("信息不足时必须给出 question 和 1-3 个 options")
    return {
        "sufficient": payload["sufficient"],
        "app_type": str(payload.get("app_type") or "").strip()[:40],
        "entity": str(payload.get("entity") or "").strip()[:20],
        "fields": _normalize_fields(payload.get("fields") or [], strict=False),
        "question": question,
        "options": options,
    }


def _validate_plan(payload: dict) -> dict:
    title = str(payload.get("title") or "").strip()
    if not title:
        raise ValueError("title 不能为空")
    entity = str(payload.get("entity") or "记录").strip()[:20]
    defaults = payload.get("defaults") or []
    if not isinstance(defaults, list):
        raise ValueError("defaults 必须是字符串数组")
    fields = _normalize_fields(payload.get("fields"), strict=True)
    return {
        "title": title[:40],
        "summary": str(payload.get("summary") or "").strip()[:400],
        "entity": entity,
        "fields": fields,
        "defaults": [str(d).strip()[:120] for d in defaults if str(d).strip()][:8],
        "files": [{"path": path, "purpose": FILE_PURPOSES[path]} for path in FILE_PATHS],
        "api": API_CONTRACT,
        "max_length": max([f.get("max_length", 0) for f in fields] + [DEFAULT_MAX_LENGTH]),
    }


async def judge_intent(requirement: str) -> dict:
    system = (
        "你是应用生成平台的需求分析器。平台只能生成「单页面、处理一组同构数据对象的增删改查」Web 应用，"
        "无账号、无上传、无支付、无多页面。判断用户需求是否已能确定要管理的数据对象。"
        "如果需求明确了数据对象（例如任务清单、读书记录、联系人），sufficient=true，并推断字段。"
        "如果需求过于笼统、看不出数据对象（例如「做个网页」），sufficient=false，给出一个追问 question 和"
        "最多 3 个 options，每个 option 都是一句可直接作为完整回答提交的具体应用描述。只返回 JSON。"
    )
    hint = (
        '{"sufficient": boolean, "app_type": string, "entity": string, '
        '"fields": [{"name": 英文标识, "label": 中文名, "type": "text|number|boolean|date", '
        '"required": boolean, "max_length": number}], "question": string, "options": string[] (≤3)}'
    )
    return await _json_call(system, f"用户需求：{requirement}\n输出结构：{hint}", hint, _validate_intent)


async def make_plan(requirement: str, intent: dict | None, feedback: str, previous: dict | None) -> dict:
    system = (
        "你是应用生成平台的规划器。为单页面 CRUD 应用确定数据对象与字段。需求中没说清的部分用合理默认值补齐，"
        "并把每一条补齐的默认值写进 defaults（例如「文本长度上限 200 字」「新增记录默认未完成」）。"
        "字段 name 用英文驼峰，不得使用 id/createdAt/updatedAt/requestId；至少一个 text 字段；"
        "需要「完成」等状态时用 boolean 字段。只返回 JSON。"
    )
    hint = (
        '{"title": 应用名, "summary": 一句话说明, "entity": 数据对象中文名, '
        '"fields": [{"name": string, "label": string, "type": "text|number|boolean|date", '
        '"required": boolean, "max_length": number(仅 text)}], "defaults": string[]}'
    )
    parts = [f"用户需求：{requirement}"]
    if intent:
        parts.append(f"需求分析结果：{json.dumps(intent, ensure_ascii=False)}")
    if previous:
        parts.append(f"上一版计划（用户不认可）：{json.dumps(previous, ensure_ascii=False)}")
        parts.append(f"用户意见：{feedback or '用户未说明原因，请换一种更贴合需求的字段设计'}")
    parts.append(f"输出结构：{hint}")
    return await _json_call(system, "\n".join(parts), hint, _validate_plan)


def _extract_code(text: str, path: str) -> str:
    lang = {"server.js": "(?:js|javascript)", "app.js": "(?:js|javascript)", "index.html": "(?:html)"}[path]
    match = re.search(rf"```{lang}?\s*\n(.*?)```", text, re.DOTALL | re.IGNORECASE)
    code = (match.group(1) if match else text).strip()
    if path == "index.html":
        if "<html" not in code.lower():
            raise ValueError("index.html 必须是完整 HTML 文档")
    elif not code or code.lower().startswith("<!doctype"):
        raise ValueError(f"{path} 内容为空或不是 JavaScript")
    return code + "\n"


REVISION_KINDS = {"increment", "new_app", "type_change", "unsupported"}
REVISION_DEFAULT_REASON = {
    "new_app": "这次要求更换了数据对象或应用形态，相当于一个新应用，请新建会话来生成。",
    "type_change": "暂不支持修改已有字段的类型：自动迁移可能让旧数据变形或丢失。可以新增一个新字段，或新建会话。",
    "unsupported": "这次要求超出了能力范围（例如多页面、登录、上传、支付），没有执行。",
}


def _validate_revision(payload: dict, plan: dict) -> dict:
    kind = str(payload.get("kind") or "").strip()
    if kind not in REVISION_KINDS:
        raise ValueError("kind 必须是 increment/new_app/type_change/unsupported 之一")
    reason = str(payload.get("reason") or "").strip()[:300]
    if kind != "increment":
        return {"kind": kind, "reason": reason or REVISION_DEFAULT_REASON[kind]}
    fields = _normalize_fields(payload.get("fields"), strict=True)
    old = {f["name"]: f for f in plan.get("fields") or []}
    for field in fields:
        prev = old.get(field["name"])
        if prev and prev.get("type") != field["type"]:
            return {
                "kind": "type_change",
                "reason": f"字段「{prev.get('label')}」的类型要从 {prev.get('type')} 改成 {field['type']}。"
                + REVISION_DEFAULT_REASON["type_change"],
            }
    added = [f["name"] for f in fields if f["name"] not in old]
    removed = [name for name in old if name not in {f["name"] for f in fields}]
    affected = [p for p in FILE_PATHS if p in (payload.get("affected") or [])]
    if added or removed:
        affected = [p for p in FILE_PATHS if p in affected or p in ("server.js", "app.js")]
    change = str(payload.get("change") or "").strip()[:300]
    return {
        "kind": "increment",
        "reason": reason,
        "change": change,
        "fields": fields,
        "added": added,
        "removed": removed,
        "affected": affected or ["app.js"],
    }


async def judge_revision(plan: dict, files: dict[str, str], request: str) -> dict:
    """Classify a change request in preview and compute its impact scope."""
    system = (
        "你是应用生成平台的修改分析器。用户正在对一个已生成、正在运行的单页面 CRUD 应用提修改要求。判定 kind：\n"
        "- increment：在同一数据对象上的增量修改，例如加/删字段、排序、筛选、改文案或样式。\n"
        "- new_app：更换数据对象或应用形态，例如把任务清单改成记账本。\n"
        "- type_change：要把已有字段改成另一种类型（例如文本改数字、单值改列表）。\n"
        "- unsupported：多页面、登录/账号、上传、支付、实时协作等超出能力范围的要求。\n"
        "kind=increment 时给出修改后的完整字段列表 fields（保留未改动字段的 name 与 type 原样；新字段 name 用英文驼峰），"
        "affected 列出必须改动的文件（server.js 负责数据与校验，index.html 负责结构与样式，app.js 负责渲染与交互），"
        "只列真正受影响的文件；change 用一句话描述本次修改。只返回 JSON。"
    )
    hint = (
        '{"kind": "increment|new_app|type_change|unsupported", "reason": string, "change": string, '
        '"fields": [{"name": string, "label": string, "type": "text|number|boolean|date", "required": boolean, '
        '"max_length": number}], "affected": ["server.js"|"index.html"|"app.js"]}'
    )
    plan_view = {k: plan.get(k) for k in ("title", "entity", "fields", "changes", "removed")}
    excerpt = "\n\n".join(f"--- {p}（节选）---\n{(files.get(p) or '')[:4000]}" for p in FILE_PATHS)
    user = (
        f"当前计划：{json.dumps(plan_view, ensure_ascii=False)}\n{excerpt}\n\n修改要求：{request}\n输出结构：{hint}"
    )
    return await _json_call(system, user, hint, lambda payload: _validate_revision(payload, plan))


async def generate_file(
    plan: dict, path: str, files: dict[str, str], repair: dict | None, change: str = ""
) -> dict:
    if path not in FILE_PATHS:
        raise HTTPException(status_code=400, detail=f"未知文件：{path}")
    system = (
        "你是资深前端/全栈工程师，为一个单页面 CRUD 应用编写完整文件。"
        f"{RUNTIME_CONTRACT}\n只输出这一个文件的完整内容，放在一个代码块中，不要解释。"
    )
    plan_view = {
        k: plan.get(k) for k in ("title", "summary", "entity", "fields", "defaults", "api", "changes", "removed")
    }
    parts = [
        f"应用计划（字段与接口契约必须严格对齐）：\n{json.dumps(plan_view, ensure_ascii=False, indent=1)}",
        f"当前任务：编写 {path} —— {FILE_PURPOSES[path]}",
    ]
    others = {p: c for p, c in files.items() if p != path and p in FILE_PATHS and c}
    if others:
        context = "\n\n".join(f"--- {p} ---\n{c[:12000]}" for p, c in others.items())
        parts.append(f"已完成的其它文件（保持 DOM id、接口与字段一致）：\n{context}")
    if change and files.get(path) and not repair:
        parts.append(
            f"这是一次增量修改：{change}\n请在下面的当前 {path} 基础上只改动必要部分，保留其它正确逻辑，"
            f"并保证此前累计的修改仍然生效。当前 {path}：\n{files[path][:16000]}"
        )
    if repair:
        parts.append(
            f"这是第 {repair.get('attempt', 1)} 次自动修复。上一版 {path} 未通过检查。\n"
            f"错误信息（末 40 行）：\n{str(repair.get('error', ''))[-4000:]}\n"
            f"上一版 {path}：\n{str(repair.get('current', ''))[:16000]}\n"
            "请针对错误修正并输出完整文件，保留无关的正确部分。"
        )
    messages = [ChatMessage(role="system", content=system), ChatMessage(role="user", content="\n\n".join(parts))]
    raw = await _call_model(messages, 12000)
    try:
        code = _extract_code(raw, path)
    except ValueError as first_error:
        messages.append(ChatMessage(role="assistant", content=raw[:8000]))
        messages.append(
            ChatMessage(role="user", content=f"输出格式不合法：{first_error}。请只输出完整文件，放在一个代码块中。")
        )
        try:
            code = _extract_code(await _call_model(messages, 12000), path)
        except ValueError as exc:
            raise HTTPException(status_code=502, detail=f"模型返回结构不合法：{exc}") from exc
    return {"path": path, "content": code, "lines": code.count("\n")}


async def summarize(messages: list[dict]) -> str:
    transcript = "\n".join(f"[{m.get('role')}] {str(m.get('text', ''))[:800]}" for m in messages[-60:])
    system = (
        "你负责为应用生成会话写摘要。用简体中文 Markdown，分「需求」「计划要点」「过程与结果」三个小节，"
        "每节 1-4 条要点，总长不超过 300 字。"
    )
    return (
        await _call_model(
            [ChatMessage(role="system", content=system), ChatMessage(role="user", content=transcript)], 1200
        )
    ).strip()

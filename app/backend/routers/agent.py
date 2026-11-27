"""Agent endpoints driving the intent → plan → generate pipeline (no login required)."""

from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field
from services import agent

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])


class IntentRequest(BaseModel):
    requirement: str = Field(..., min_length=1, max_length=2000)


class PlanRequest(BaseModel):
    requirement: str = Field(..., min_length=1, max_length=4000)
    intent: Optional[dict[str, Any]] = None
    feedback: str = ""
    previous: Optional[dict[str, Any]] = None


class RepairContext(BaseModel):
    error: str = ""
    attempt: int = 1
    current: str = ""


class GenerateRequest(BaseModel):
    plan: dict[str, Any]
    path: str
    files: dict[str, str] = {}
    repair: Optional[RepairContext] = None
    change: str = ""


class ReviseRequest(BaseModel):
    plan: dict[str, Any]
    files: dict[str, str] = {}
    request: str = Field(..., min_length=1, max_length=2000)


class ChatItem(BaseModel):
    role: str
    text: str


class SummaryRequest(BaseModel):
    messages: list[ChatItem]


@router.post("/intent")
async def intent(data: IntentRequest):
    return await agent.judge_intent(data.requirement.strip())


@router.post("/plan")
async def plan(data: PlanRequest):
    return await agent.make_plan(data.requirement.strip(), data.intent, data.feedback.strip(), data.previous)


@router.post("/generate")
async def generate(data: GenerateRequest):
    repair = data.repair.model_dump() if data.repair else None
    return await agent.generate_file(data.plan, data.path, data.files, repair, data.change.strip())


@router.post("/revise")
async def revise(data: ReviseRequest):
    return await agent.judge_revision(data.plan, data.files, data.request.strip())


@router.post("/summary")
async def summary(data: SummaryRequest):
    return {"summary": await agent.summarize([m.model_dump() for m in data.messages])}

import json
from datetime import date, datetime
from typing import Optional

from core.database import get_db
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from services.atoms_docs import AtomsDocsService
from sqlalchemy.ext.asyncio import AsyncSession


router = APIRouter(prefix="/api/v1/entities/atoms_docs", tags=["atoms_docs"])


class AtomsDocsData(BaseModel):
    sid: str
    kind: str
    name: str
    content: str


class AtomsDocsUpdateData(BaseModel):
    sid: Optional[str] = None
    kind: Optional[str] = None
    name: Optional[str] = None
    content: Optional[str] = None


class AtomsDocsResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    sid: str
    kind: str
    name: str
    content: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class AtomsDocsListResponse(BaseModel):
    items: list[AtomsDocsResponse]
    total: int
    skip: int
    limit: int


def parse_query(value: str | None) -> dict | None:
    if not value:
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid query JSON") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Query must be a JSON object")
    return parsed


@router.get("", response_model=AtomsDocsListResponse)
async def query_items(
    query: str | None = Query(None),
    sort: str | None = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=2000),
    fields: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await AtomsDocsService(db).get_list(
            skip=skip, limit=limit, query=parse_query(query), sort=sort, user_id=None
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/all", response_model=AtomsDocsListResponse)
async def query_all_items(
    query: str | None = Query(None),
    sort: str | None = Query(None),
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=2000),
    fields: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await AtomsDocsService(db).get_list(
            skip=skip, limit=limit, query=parse_query(query), sort=sort
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/{item_id}", response_model=AtomsDocsResponse)
async def get_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
):
    item = await AtomsDocsService(db).get_by_id(item_id, None)
    if item is None:
        raise HTTPException(status_code=404, detail="AtomsDocs not found")
    return item


@router.post("", response_model=AtomsDocsResponse, status_code=201)
async def create_item(
    data: AtomsDocsData,
    db: AsyncSession = Depends(get_db),
):
    return await AtomsDocsService(db).create(data.model_dump(exclude_unset=True), None)


@router.put("/{item_id}", response_model=AtomsDocsResponse)
async def update_item(
    item_id: int,
    data: AtomsDocsUpdateData,
    db: AsyncSession = Depends(get_db),
):
    item = await AtomsDocsService(db).update(
        item_id, data.model_dump(exclude_unset=True), None
    )
    if item is None:
        raise HTTPException(status_code=404, detail="AtomsDocs not found")
    return item


@router.delete("/{item_id}")
async def delete_item(
    item_id: int,
    db: AsyncSession = Depends(get_db),
):
    deleted = await AtomsDocsService(db).delete(item_id, None)
    if not deleted:
        raise HTTPException(status_code=404, detail="AtomsDocs not found")
    return {"id": item_id, "deleted": True}

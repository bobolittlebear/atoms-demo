#!/usr/bin/env python
# -*- coding: utf-8 -*-
# @Desc   :

import asyncio
import importlib
import pkgutil
import sys
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import create_async_engine

from dotenv import load_dotenv  # 引入 dotenv
import os

# 1. 强制加载项目根目录下的 .env 文件
load_dotenv()


def clear_backend_import_cache():
    roots = ("core.database", "models")
    prefixes = tuple(f"{root}." for root in roots)
    for module_name in list(sys.modules):
        if module_name in roots or module_name.startswith(prefixes):
            sys.modules.pop(module_name, None)
    importlib.invalidate_caches()


clear_backend_import_cache()
from core.database import Base, prepare_async_database_url
import models

# Automatically import all ORM models under Models
for _, module_name, _ in pkgutil.iter_modules(models.__path__):
    importlib.import_module(f"{models.__name__}.{module_name}")

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


# 2. 从环境变量获取真实的 DATABASE_URL，并覆盖 alembic.ini 里的假 URL
database_url = os.getenv("DATABASE_URL")
if not database_url:
    raise RuntimeError("错误：未在 .env 中找到 DATABASE_URL，请检查路径或文件名！")

# 将真实 URL 注入到 Alembic 配置中
config.set_main_option("sqlalchemy.url", database_url)

# Interpret the config file for Python logging.
if config.config_file_name is not None:
    fileConfig(config.config_file_name)


def alembic_include_object(object, name, type_, reflected, compare_to):
    # type_ can be 'table', 'index', 'column', 'constraint'
    # Auth tables are part of target_metadata and are managed by Alembic.
    # Keep only the legacy session table outside migration ownership.
    if type_ == "table" and name in ["sessions"]:
        return False
    return True


async def run_migrations_online():
    database_url = prepare_async_database_url(config.get_main_option("sqlalchemy.url"))
    print("DEBUG database_url =", repr(database_url))
    connectable = create_async_engine(database_url, poolclass=pool.NullPool)
    async with connectable.connect() as connection:
        await connection.run_sync(
            lambda sync_conn: context.configure(
                connection=sync_conn,
                target_metadata=target_metadata,
                compare_type=True,
                compare_server_default=True,
                include_object=alembic_include_object,
            )
        )
        async with connection.begin():
            await connection.run_sync(lambda sync_conn: context.run_migrations())
    await connectable.dispose()


def run_migrations():
    try:
        # If there is no event loop currently, use asyncio.run directly
        loop = asyncio.get_running_loop()
        loop.create_task(run_migrations_online())
    except RuntimeError:
        asyncio.run(run_migrations_online())


run_migrations()

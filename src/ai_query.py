"""Model calls for the explorer's AI mode: local Ollama first, Gemini second.

The AI never sees the network. The browser builds the prompt (one copy of it,
shared with the single-file build, which calls Gemini directly with the
reader's own key); this module only picks a model and forwards the request.
The model answers a few multiple-choice questions about the user's sentence;
every candidate is still computed by app.js.

Model choice goes through ~/ClaudeCode/lib/llm_quota.py when it is there:
the Gemini free tier is one bucket per model shared by every key on the
account, so this project has to see what the other three already used today.
On someone else's machine the ledger is absent and the candidates are simply
tried in order.
"""

import os
import sys

import requests

sys.path.insert(0, os.getenv("CLAUDECODE_LIB", os.path.expanduser("~/ClaudeCode/lib")))
try:
    import llm_quota  # noqa: E402
except ImportError:  # not on the author's machine
    llm_quota = None

PROJECT = "sg-commute-housing"
API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models"
# Measured 2026-09-22: a healthy lite model answers in ~6 s, while an overloaded
# one either 503s or hangs past 40 s. Give up early and try the next one.
TIMEOUT = 15


class AIError(RuntimeError):
    """Every candidate failed; the message is safe to show in the UI."""


def _t(lang, zh, en):
    """Messages reach the page as-is, so they follow its language."""
    return en if lang == "en" else zh


def validate_key(key, lang=None):
    """(ok, message). Lists models, which costs no generation quota."""
    try:
        r = requests.get(MODELS_URL, headers={"x-goog-api-key": key}, timeout=15)
    except requests.RequestException as e:
        return False, _t(lang, f"連不上 Gemini：{e}", f"Could not reach Gemini: {e}")
    if r.status_code == 200:
        return True, _t(lang, "Gemini key 可以用。", "The Gemini key works.")
    return False, _t(lang, f"這把 key 不能用（HTTP {r.status_code}）。到 aistudio.google.com/apikey 確認一下。",
                     f"That key does not work (HTTP {r.status_code}). Check it at aistudio.google.com/apikey.")


def _quota_violation(resp):
    """quotaId and limit from a 429 -- the only trustworthy source of free-tier numbers."""
    try:
        details = resp.json().get("error", {}).get("details", [])
    except ValueError:
        return "", None
    for det in details:
        for v in det.get("violations", []):
            limit = v.get("quotaValue")
            return v.get("quotaId", ""), int(limit) if limit else None
    return "", None


def ollama_up(host):
    try:
        return requests.get(host.rstrip("/") + "/api/tags", timeout=1).ok
    except requests.RequestException:
        return False


def ollama_chat(host, model, system, user, schema, temperature, lang=None):
    """Ollama /api/chat with a JSON schema. `think` off: this is classification,
    and qwen's reasoning trace only adds latency. Retried without it for models
    that reject the field (the telegram bot does the same)."""
    body = {"model": model, "stream": False, "think": False, "options": {"temperature": temperature},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if schema:
        body["format"] = schema
    url = host.rstrip("/") + "/api/chat"
    try:
        # 90 s: a cold start loads 6.6 GB before the first token
        r = requests.post(url, json=body, timeout=90)
        if r.status_code == 400:
            body.pop("think")
            r = requests.post(url, json=body, timeout=90)
        r.raise_for_status()
        return r.json()["message"]["content"]
    except (requests.RequestException, KeyError, ValueError) as e:
        raise AIError(_t(lang, f"本機模型沒有回應（{e}）。", f"The local model did not answer ({e}).")) from e


def gemini_body(system, user, schema, temperature):
    body = {"system_instruction": {"parts": [{"text": system}]}, "contents": [{"parts": [{"text": user}]}],
            "generationConfig": {"temperature": temperature}}
    if schema:
        body["generationConfig"].update(response_mime_type="application/json", response_schema=schema)
    return body


def complete(system, user, schema, temperature, *, ollama_host, ollama_model, gemini_key, gemini_models, lang=None):
    """Returns (text, label of what answered). Local first, cloud second."""
    errors = []
    if ollama_host and ollama_up(ollama_host):
        try:
            return (ollama_chat(ollama_host, ollama_model, system, user, schema, temperature, lang),
                    _t(lang, "本機 ", "local ") + ollama_model)
        except AIError as e:
            errors.append(str(e))
    if gemini_key:
        text, model = generate(gemini_key, gemini_body(system, user, schema, temperature), gemini_models, lang)
        return text, model
    raise AIError(" ".join(errors) or _t(lang, "沒有可用的 AI：本機 Ollama 沒開，也沒設定 Gemini key。",
                                         "No AI available: local Ollama is not running and no Gemini key is set."))


def generate(key, body, models, lang=None):
    """POST `body` (a generateContent request) to the first model with quota left.

    Returns (text, model). Someone is waiting in front of the page, so a model
    at its per-minute limit is skipped rather than waited for.
    """
    remaining = list(models)
    last = _t(lang, "沒有可用的模型", "no model available")
    while remaining:
        if llm_quota:
            model = llm_quota.pick(remaining, project=PROJECT, wait_for_rpm=False)
            if model is None:
                raise AIError(_t(lang, "Gemini 免費額度今天用完了（其他專案也共用這個額度）。明天再試，或先用手動模式。",
                                 "Today's free Gemini quota is used up (other projects share it). Try tomorrow, or use Manual."))
        else:
            model = remaining[0]
        remaining.remove(model)
        try:
            r = requests.post(API.format(model=model), json=body, timeout=TIMEOUT,
                              headers={"x-goog-api-key": key, "Content-Type": "application/json"})
        except requests.RequestException as e:
            last = _t(lang, f"{model} 連線失敗：{e}", f"{model} connection failed: {e}")
            continue
        if r.status_code == 429:
            qid, limit = _quota_violation(r)
            if llm_quota and qid:
                llm_quota.record_429(model, project=PROJECT, quota_id=qid, limit=limit)
            last = _t(lang, f"{model} 額度用盡", f"{model} out of quota")
            continue
        if r.status_code != 200:
            last = f"{model} HTTP {r.status_code}"
            continue
        try:
            text = r.json()["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError, ValueError):
            last = _t(lang, f"{model} 回傳格式看不懂", f"{model} sent an unreadable reply")
            continue
        if llm_quota:
            llm_quota.record_success(model, project=PROJECT)
        return text, model
    raise AIError(_t(lang, f"AI 暫時不能用（{last}）。先用手動模式。", f"AI is unavailable right now ({last}). Use Manual for now."))

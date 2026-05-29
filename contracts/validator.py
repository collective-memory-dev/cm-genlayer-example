# v0.3.3
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import json


class ContentValidator(gl.Contract):
    last_authenticity_decision: str
    last_confidence: i32
    last_summary: str
    last_context_count: i32

    def __init__(self):
        self.last_authenticity_decision = "inconclusive"
        self.last_confidence = i32(0)
        self.last_summary = ""
        self.last_context_count = i32(0)

    @gl.public.write
    def validate_user_content(self, payload_json: str, custom_prompt: str) -> None:
        if not isinstance(payload_json, str) or not payload_json.strip():
            raise gl.UserError("payload_json must be a non-empty JSON string")
        if not isinstance(custom_prompt, str):
            raise gl.UserError("custom_prompt must be a string")
        if len(custom_prompt) > 2000:
            raise gl.UserError("custom_prompt is too long (max 2000)")

        try:
            payload = json.loads(payload_json)
        except Exception as err:
            raise gl.UserError(f"Invalid payload_json: {err}")

        if not isinstance(payload, dict):
            raise gl.UserError("payload_json must decode to an object")

        raw_target = payload.get("targetMemory")
        if not isinstance(raw_target, dict):
            raise gl.UserError("targetMemory must be an object")
        raw_context = payload.get("contextMemories", [])
        if not isinstance(raw_context, list):
            raise gl.UserError("contextMemories must be an array")
        if len(raw_context) > 10:
            raise gl.UserError("contextMemories max size is 10")

        all_raw = [("targetMemory", raw_target)] + [
            (f"contextMemories[{i}]", item) for i, item in enumerate(raw_context)
        ]
        checked = []
        for label, m in all_raw:
            if not isinstance(m, dict):
                raise gl.UserError(f"{label} must be an object")
            desc = m.get("description", "")
            city = m.get("city", "")
            country = m.get("country", "")
            cap = m.get("captured_at", "")
            if not isinstance(desc, str) or not desc.strip():
                raise gl.UserError(f"{label}.description required")
            if not isinstance(city, str) or not city.strip():
                raise gl.UserError(f"{label}.city required")
            if not isinstance(country, str) or not country.strip():
                raise gl.UserError(f"{label}.country required")
            if not isinstance(cap, str) or not cap.strip():
                raise gl.UserError(f"{label}.captured_at required")
            mt = m.get("media_type", "image")
            if not isinstance(mt, str) or mt.strip().lower() not in ("image", "video"):
                raise gl.UserError(f"{label}.media_type must be image or video")
            checked.append({
                "description": desc.strip(),
                "city": city.strip(),
                "country": country.strip(),
                "captured_at": cap.strip(),
                "media_type": mt.strip().lower(),
            })

        target_memory = checked[0]
        context_memories = checked[1:]

        memories_block = [{"role": "target", **target_memory}] + [
            {"role": "context", **item} for item in context_memories
        ]
        memories_text = json.dumps(memories_block, ensure_ascii=True)
        custom_prompt_text = (
            custom_prompt.strip()
            if custom_prompt.strip()
            else "Evaluate authenticity using temporal, geographic, and narrative consistency checks."
        )

        prompt = f"""Custom validator instructions:
{custom_prompt_text}

System requirements:
1) Base your answer only on the provided memory data.
2) Output JSON only.

Memories:
{memories_text}

Return a JSON object with exactly:
{{"decision": "authentic" or "suspicious" or "inconclusive", "confidence": integer 0-100, "summary": "short explanation focused on authenticity signals"}}"""

        def leader_fn():
            result = gl.nondet.exec_prompt(prompt, response_format="json")
            if not isinstance(result, dict):
                raise gl.UserError(f"LLM returned non-dict: {type(result)}")
            return result

        def validator_fn(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return False
            data = leader_result.calldata
            if not isinstance(data, dict):
                return False
            decision = data.get("decision")
            if not isinstance(decision, str):
                return False
            if decision.strip().lower() not in ("authentic", "suspicious", "inconclusive"):
                return False
            confidence = data.get("confidence")
            if confidence is None:
                return False
            try:
                c = int(round(float(str(confidence).strip())))
            except Exception:
                return False
            if c < 0 or c > 100:
                return False
            summary = data.get("summary")
            if not isinstance(summary, str) or not summary.strip():
                explanation = data.get("explanation")
                if not isinstance(explanation, str) or not explanation.strip():
                    return False
            return True

        result = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

        raw_decision = str(result.get("decision", "")).strip().lower()
        if raw_decision == "authentic":
            decision = "authentic"
        elif raw_decision == "suspicious":
            decision = "suspicious"
        elif raw_decision == "inconclusive":
            decision = "inconclusive"
        elif "auth" in raw_decision or "real" in raw_decision:
            decision = "authentic"
        elif "susp" in raw_decision or "fake" in raw_decision:
            decision = "suspicious"
        else:
            decision = "inconclusive"

        raw_confidence = result.get("confidence", 0)
        try:
            confidence = int(round(float(str(raw_confidence).strip())))
        except Exception:
            confidence = 0
        if confidence < 0:
            confidence = 0
        if confidence > 100:
            confidence = 100

        summary = result.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            summary = result.get("explanation")
        if not isinstance(summary, str) or not summary.strip():
            summary = "Could not produce a reliable authenticity summary."

        self.last_authenticity_decision = decision
        self.last_confidence = i32(confidence)
        self.last_summary = summary
        self.last_context_count = i32(len(context_memories))

    @gl.public.view
    def get_last_validation(self) -> dict:
        return {
            "decision": self.last_authenticity_decision,
            "confidence": self.last_confidence,
            "summary": self.last_summary,
            "context_count": self.last_context_count,
        }

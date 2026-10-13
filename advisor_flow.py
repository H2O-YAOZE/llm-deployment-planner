"""One field-driven dialogue policy for every model, chip and customer."""
import json
import re
from pathlib import Path

SCHEMA = json.loads((Path(__file__).with_name('advisor-fields.json')).read_text('utf-8'))
FIELDS = {f['key']: f for f in SCHEMA['fields']}
FLEXIBLE = {k for k, f in FIELDS.items() if f.get('suggestible')}
SOLVED = {'concurrency':'concurrency', 'speed':'speed', 'ttft':'ttft', 'input':'inputK', 'output':'outputK'}


def flexible_fields(raw):
    return sorted({k for k in raw if isinstance(k, str) and k in FLEXIBLE}) if isinstance(raw, list) else []


def present(key, requirements):
    value = requirements.get(key)
    return value is not None and value != '' and value != 'unknown'


def active_fields(requirements):
    reverse = requirements.get('mode') == 'reverse'
    solved = SOLVED.get(requirements.get('reverseTarget')) if reverse else None
    return [f for f in SCHEMA['fields']
            if f['key'] != solved
            and (not f.get('reverseOnly') or reverse)
            and (not f.get('outputTargetOnly') or reverse and solved == 'outputK')
            and not (f['key'] == 'speed' and requirements.get('outputK') == .001)]


def precision_clarification(request, extracted=None):
    """Interpret short replies only when the known requirements identify the field."""
    requirements = request['requirements']
    if present('precision', requirements):
        return None
    pattern = r'(?:精度(?:是|为)?\s*)?(4|8|16)\s*(?:bit|位)?[。.!！]?'
    def width(text):
        match = re.fullmatch(pattern, text.strip(), re.I) if isinstance(text, str) else None
        return match.group(1) if match else None
    bits = width(extracted)
    missing = [f['key'] for f in active_fields(requirements)
               if not present(f['key'], requirements) and f['key'] not in request.get('flexible_fields', [])]
    if missing == ['precision']:
        bits = width(request['scenario_text']) or bits
        # "Nothing else" neither supplies precision nor authorizes a recommendation.
        if not bits and re.fullmatch(r'(?:没了|没有了|就这些|没有其他要求)[。.!！]?', request['scenario_text']):
            last_user = next((m['content'] for m in reversed(request['messages']) if m['role'] == 'user'), '')
            bits = width(last_user)
    if not bits:
        return None
    return {
        '8': '你说的“8”是 INT8（整数8位）还是 FP8（浮点8位）？两者不能混用；也可以说“你推荐”。',
        '16': '你说的“16”是 FP16 还是 BF16？请确认格式，或说“你推荐”。',
        '4': '你说的“4”是 INT4、MXFP4 还是 NVFP4？请确认格式，或说“你推荐”。'
    }[bits]


def explicit_precision_reply(request):
    if present('precision', request['requirements']):
        return None
    missing = [f['key'] for f in active_fields(request['requirements'])
               if not present(f['key'], request['requirements']) and f['key'] not in request.get('flexible_fields', [])]
    text = request['scenario_text'].strip().lower().rstrip('。.!！')
    return text if missing == ['precision'] and text in SCHEMA['validation']['precisions'] else None


def build(answer, request, raw, clean_requirements):
    requirements = answer['requirements']
    # "No preference / recommend something" is a valid policy, not a number.
    # An explicit value replaces flexibility. Locks cannot be made flexible.
    evidence = raw.get('flexible_evidence', {})
    evidence = evidence if isinstance(evidence,dict) else {}
    customer_texts = [m['content'] for m in request['messages'] if m['role']=='user'] + [request['scenario_text']]
    newly_flexible = {k for k in flexible_fields(raw.get('flexible_fields'))
                      if isinstance(evidence.get(k),str) and evidence[k].strip() and any(evidence[k] in t for t in customer_texts)}
    flexible = set(request.get('flexible_fields', [])) | newly_flexible
    if isinstance(requirements.get('domesticOnly'),bool) and not requirements.get('card'):
        flexible.add('card')
    flexible -= set(requirements) | set(answer['hard_constraints'])
    proposed = {**request.get('suggested_requirements', {}), **clean_requirements(raw.get('suggested_requirements', {}))}
    proposed = {k:v for k,v in proposed.items() if k in flexible}
    combined = {**proposed, **requirements}
    # Choosing among declared compatible chip/precision paths is program work.
    # These are still suggestions requiring customer confirmation, not facts
    # or promises of throughput. Never choose a model without a model proposal.
    model_id = combined.get('model')
    if model_id:
        cards = {c['id']:c for c in request['catalog']['cards']}
        def eligible_precisions(path):
            return [precision for precision in path.get('precisions', [])
                    if precision not in path.get('planningPrecisions', [])
                    or (requirements.get('model') == path.get('model')
                        and requirements.get('card') == path.get('card')
                        and requirements.get('precision') == precision)]
        candidates = [p for p in request['catalog']['paths'] if p.get('model')==model_id
                      and eligible_precisions(p)
                      and (not requirements.get('card') or p.get('card')==requirements['card'])
                      and (not requirements.get('precision') or requirements['precision'] in eligible_precisions(p))
                      and (not requirements.get('domesticOnly') or cards.get(p.get('card'),{}).get('domestic'))]
        candidates.sort(key=lambda p: p.get('card')!=proposed.get('card'))
        if candidates:
            path=candidates[0]
            if 'card' in flexible:
                proposed['card']=path['card']
            if 'precision' in flexible and path.get('precisions'):
                supported=[p for p in path['precisions'] if p not in path.get('planningPrecisions',[])]
                if supported:
                    proposed['precision']=proposed.get('precision') if proposed.get('precision') in supported else supported[0]
        combined={**proposed,**requirements}
    model = next((m for m in request['catalog']['models'] if m.get('id') == requirements.get('model')), None)
    paths = {(p.get('model'),p.get('card'),precision) for p in request['catalog']['paths'] for precision in p.get('precisions', [])
             if precision not in p.get('planningPrecisions', [])
             or (requirements.get('model') == p.get('model') and requirements.get('card') == p.get('card') and requirements.get('precision') == precision)}
    # A suggested combination needs the same deployment evidence as a plan.
    if all(combined.get(k) for k in ('model','card','precision')) and (combined['model'],combined['card'],combined['precision']) not in paths:
        proposed = {k:v for k,v in proposed.items() if k not in {'model','card','precision'}}
        combined = {**proposed, **requirements}
    if requirements.get('domesticOnly'):
        domestic = next((c for c in request['catalog']['cards'] if c.get('id') == proposed.get('card')), None)
        if domestic and not domestic.get('domestic'):
            proposed.pop('card',None)
            combined = {**proposed, **requirements}
    states = []
    missing = []
    for field in active_fields(requirements):
        key = field['key']
        status = 'specified' if present(key,requirements) else 'suggested' if present(key,proposed) else 'flexible' if key in flexible else 'missing'
        states.append({'field':key,'status':status})
        if status == 'missing':
            missing.append(field)
    # A typed clarification can only address a missing field. Model-generated
    # prose cannot reopen a specified field, regardless of its wording.
    clarifications = raw.get('clarifications', [])
    if not isinstance(clarifications, list):
        clarifications = []
    missing_keys = {f['key'] for f in missing}
    clarification_by_field = {c['field']:c['question'].strip()[:120] for c in clarifications
                              if isinstance(c,dict) and c.get('field') in missing_keys and isinstance(c.get('question'),str) and c['question'].strip()}
    if model and model.get('local') is False:
        question = model['name']+' 暂无可核验的本地部署数据。要换一个已有部署数据的模型试算吗？'
        next_field = 'model'
        ready = False
    elif missing:
        prompts = [f['label']+'：'+clarification_by_field[f['key']] if f['key'] in clarification_by_field else f.get('prompt',f['question']) for f in missing]
        question = (clarification_by_field[missing[0]['key']] if len(missing) == 1 and missing[0]['key'] in clarification_by_field
                    else '还差这些信息，一次补充即可：\n'+'\n'.join('• '+p for p in prompts)+'\n没有要求的项可以说“你推荐”。')
        next_field = missing[0]['key']
        ready = False
    else:
        unsuggested = [s['field'] for s in states if s['status'] == 'flexible']
        next_field = unsuggested[0] if unsuggested else None
        question = ('已记下你对'+FIELDS[next_field]['label']+'没有指定要求，目前还缺少可核验的试算建议。' if next_field else '')
        ready = not unsuggested and not answer.get('unresolved') and not answer.get('pending_changes')
    path_note = next((p.get('estimationNote', '') for p in request['catalog']['paths']
                      if p.get('model') == combined.get('model') and p.get('card') == combined.get('card')), '')
    estimate_notes = [n for n in [path_note, model.get('estimationNote', '') if model else ''] if n]
    answer['warnings'] = list(dict.fromkeys(answer.get('warnings', []) + estimate_notes))
    if path_note and question:
        question = path_note + '\n' + question
    answer['flexible_fields'] = sorted(flexible)
    answer['suggested_requirements'] = proposed
    answer['flow'] = {'version':SCHEMA['version'],'fields':states,'next_field':next_field,'next_fields':[f['key'] for f in missing],'question':question,'ready':ready}
    # Legacy consumers still get one program-selected question, never an
    # appended repetition of assistant_message or an old unresolved question.
    answer['questions'] = [question] if question else []
    return answer

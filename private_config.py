"""Read an allowlisted .env.local as data; never evaluate shell syntax."""
import os
import re
from pathlib import Path

ALLOWED = frozenset({
    'TYPESAFE_API_KEY', 'JEV_API_KEY', 'TYPESAFE_MODEL', 'JEV_ENABLED', 'JEV_AUTO_REVIEW', 'JEV_TIMEOUT_SECONDS',
    'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_API_URL',
    'PANEL_USER', 'PANEL_PASS', 'PANEL_GATEWAY_KEY',
})


def read_private_config(root):
    """Parse a private file without changing process environment or logging values."""
    file = Path(root) / '.env.local'
    try:
        with file.open('rb') as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise ValueError('私有配置文件过大。')
        lines = raw.decode('utf-8-sig').splitlines()
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeError) as exc:
        raise ValueError('无法读取私有配置，请检查文件权限与 UTF-8 编码。') from exc
    parsed = {}
    for line_no, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)', line)
        if not match:
            raise ValueError('私有配置格式错误，第 %d 行；请使用变量名=值。' % line_no)
        key, value = match.groups()
        if key not in ALLOWED:
            continue
        if key in parsed:
            raise ValueError('私有配置变量重复，第 %d 行。' % line_no)
        value = value.strip()
        if value.startswith(('"', "'")):
            if len(value) < 2 or value[-1] != value[0]:
                raise ValueError('私有配置引号未闭合，第 %d 行。' % line_no)
            value = value[1:-1]
        if '\x00' in value:
            raise ValueError('私有配置包含无效字符，第 %d 行。' % line_no)
        # No interpolation, command substitution, escape expansion or inline comments.
        parsed[key] = value
    return parsed


def configuration(root=None, environ=None):
    """Read afresh; deleting a local key revokes it on the next request.

    Existing process variables win, including explicit empty values. This
    function never persists file contents in os.environ or in a module cache.
    """
    values = read_private_config(Path(root) if root is not None else Path(__file__).resolve().parent)
    source = os.environ if environ is None else environ
    values.update({key: source[key] for key in ALLOWED if key in source})
    return values


def get_config(key, default=''):
    if key not in ALLOWED:
        raise ValueError('不允许读取该配置变量。')
    return configuration().get(key, default)

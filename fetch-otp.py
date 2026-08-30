#!/usr/bin/env python3
"""
VRChat OTP Auto-Fetcher — 通用邮箱 IMAP 抓取
Connects to IMAP, finds the latest VRChat verification email,
extracts the 6-digit OTP code, and prints it to stdout.

Usage:
  python fetch-otp.py                        # 凭据自动从 Hermes .env 读取
  python fetch-otp.py <email> <auth_code>    # IMAP 服务器自动推断
  python fetch-otp.py <email> <auth_code> <imap_host>  # 手动指定 IMAP 服务器

Returns: <6-digit-otp> on success, exits with code 1 on failure.
"""
import imaplib
import email
import re
import sys
import os
import base64
import datetime
from email.utils import parsedate_to_datetime


def load_env(path):
    env = {}
    with open(path, encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def send_imap_id(mail):
    """Send RFC 2971 IMAP ID. QQ/163 require this after LOGIN, else
    UID SEARCH/FETCH may return 'BYE Unsafe Login'. Swallow failures."""
    try:
        mail.xatom("ID", '("name" "hermes-otp" "version" "2.0" "vendor" "NousResearch")')
    except Exception:
        pass


def decode_modified_utf7(s):
    """解码 IMAP 修改版 UTF-7 (RFC 3501 5.1.3) 编码的文件夹名。
    例如 &UXZO1mWHTvZZOQ-/VRChat -> [VRChat]"""
    result = []
    i = 0
    while i < len(s):
        if s[i] == '&':
            end = s.find('-', i + 1)
            if end == -1:
                result.append(s[i])
                i += 1
            else:
                encoded = s[i+1:end]
                if not encoded:
                    result.append('&')
                else:
                    try:
                        b64 = encoded.replace(',', '/')
                        padding = 4 - len(b64) % 4
                        if padding != 4:
                            b64 += '=' * padding
                        decoded_bytes = base64.b64decode(b64)
                        result.append(decoded_bytes.decode('utf-16-be'))
                    except Exception:
                        result.append(s[i:end+1])
                i = end + 1
        else:
            result.append(s[i])
            i += 1
    return ''.join(result)


def find_vrchat_folders(mail):
    """遍历 IMAP 文件夹，找出含 'vrchat'（不区分大小写）的文件夹
    以及 Gmail "All Mail"、QQ "全部邮件" 等兜底文件夹。
    返回原始编码的文件夹名列表（供 mail.select() 直接使用）。"""
    try:
        status, folder_list = mail.list()
        if status != 'OK':
            return []

        vrchat_folders = []
        all_mail_folders = []

        for item in folder_list:
            line = item.decode('utf-8', errors='ignore') if isinstance(item, bytes) else item
            # 格式: (flags) "分隔符" "文件夹名"
            parts = line.split('"')
            if len(parts) < 4:
                continue
            raw_name = parts[-2]

            try:
                decoded = decode_modified_utf7(raw_name)
            except Exception:
                decoded = raw_name

            low_raw = raw_name.lower()
            low_decoded = decoded.lower()

            # VRChat 分类文件夹
            if 'vrchat' in low_raw or 'vrchat' in low_decoded:
                vrchat_folders.append(raw_name)

            # "所有邮件"兜底文件夹（Gmail All Mail / QQ 全部邮件 等）
            if ('all mail' in low_decoded or '全部邮件' in low_decoded or
                    '[gmail]' in low_decoded):
                all_mail_folders.append(raw_name)

        # VRChat 文件夹优先，兜底文件夹在后，去重
        result = []
        seen = set()
        for f in vrchat_folders + all_mail_folders:
            if f not in seen:
                result.append(f)
                seen.add(f)
        return result
    except Exception:
        return []


def _search_mailbox(mail):
    """在已选中的邮箱中搜索 VRChat OTP 邮件，
    返回最新且在 10 分钟内的邮件 ID，或 None。"""
    since = (datetime.datetime.now() - datetime.timedelta(days=7)).strftime('%d-%b-%Y')

    def search(criteria):
        """执行 SEARCH，返回消息 ID 列表或 None（服务器无结果 / 失败）。
        imaplib search() 返回 (status, [data])，data[0] 才是 ID 列表（b'1 2 3'）。
        注意各服务器空结果形态不同：Gmail/QQ 返回 b''，163 返回 b'(none)'，
        status 为 'NO'/'BAD' 时 data 可能为空列表——统一归一化处理。"""
        try:
            status, msgs = mail.search(None, criteria)
            if status != 'OK' or not msgs or not msgs[0]:
                return None
            data = msgs[0].strip()
            if not data or data.lower() == b'(none)':
                return None
            return data.split()
        except Exception:
            return None

    all_ids = (search(f'(FROM "vrchat" SINCE {since})')
               or search(f'(FROM "VRChat" SINCE {since})')
               or search(f'(SUBJECT "One-Time Code" SINCE {since})'))
    if all_ids is None:
        # 兜底: 扫最近 10 封的头部
        all_ids = search('ALL')
        if all_ids:
            found_id = None
            for rid in reversed(all_ids[-10:]):
                try:
                    status, data = mail.fetch(rid, '(BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])')
                    if status == 'OK':
                        hdr = data[0][1].decode('utf-8', errors='ignore')
                        if 'vrchat' in hdr.lower() or 'one-time' in hdr.lower() or 'code' in hdr.lower():
                            found_id = rid
                            break
                except Exception:
                    continue
            all_ids = [found_id] if found_id else None

    if not all_ids:
        return None

    latest_id = None
    # 检查最近 5 封，取最新且 10 分钟内的有效验证码，避免 IMAP 同步延迟取到旧码
    for rid in reversed(all_ids[-5:]):
        date_val = _get_email_date(mail, rid)
        if date_val and _is_recent(date_val):
            latest_id = rid
            break

    return latest_id


def _extract_otp_from_msg(mail, msg_id):
    """从指定邮件中提取 6 位验证码。返回验证码字符串或 None。"""
    try:
        status, data = mail.fetch(msg_id, '(RFC822)')
        if status != 'OK':
            return None

        raw = email.message_from_bytes(data[0][1])

        # 先从 Subject 提取: "Your One-Time Code is 396357"
        subject = raw['Subject'] or ''
        codes = re.findall(r'\b(\d{6})\b', subject)
        if codes:
            return codes[-1]

        # 再从正文提取
        body = ''
        if raw.is_multipart():
            for part in raw.walk():
                if part.get_content_type() == 'text/plain':
                    body = part.get_payload(decode=True)
                    body = body.decode('utf-8', errors='ignore') if body else ''
                    break
        else:
            body = raw.get_payload(decode=True)
            body = body.decode('utf-8', errors='ignore') if body else ''

        codes = re.findall(r'\b(\d{6})\b', body)
        return codes[-1] if codes else None
    except Exception:
        return None


def _get_email_date(mail, msg_id):
    """Fetch Date header from a message. Returns datetime or None."""
    try:
        status, data = mail.fetch(msg_id, '(BODY.PEEK[HEADER.FIELDS (DATE)])')
        if status != 'OK':
            return None
        for item in data:
            if isinstance(item, tuple):
                hdr_bytes = item[1]
                if hdr_bytes:
                    hdr_text = hdr_bytes.decode('utf-8', errors='ignore')
                    m = re.search(r'^Date:\s*(.+)', hdr_text, re.MULTILINE | re.IGNORECASE)
                    if m:
                        return _parse_email_date(m.group(1).strip())
    except Exception:
        pass
    return None


def _parse_email_date(date_str):
    """Parse email Date header to datetime. Returns None on failure."""
    if not date_str:
        return None
    try:
        return parsedate_to_datetime(date_str)
    except Exception:
        return None


def _is_recent(date_val, max_age_minutes=10):
    """Check if a datetime is within max_age_minutes of now."""
    if date_val is None:
        return False
    now = datetime.datetime.now(datetime.timezone.utc)
    if date_val.tzinfo is None:
        date_val = date_val.replace(tzinfo=datetime.timezone.utc)
    age = (now - date_val).total_seconds()
    return 0 <= age <= max_age_minutes * 60


def infer_imap_host(email_addr):
    """根据邮箱域名推断 IMAP 服务器地址。
    返回 None 表示该邮箱不支持 IMAP 直连（如 proton.me）。"""
    domain = email_addr.rsplit('@', 1)[-1].lower() if '@' in email_addr else ''
    if not domain:
        raise ValueError(f"无法从邮箱地址提取域名: {email_addr}")

    mapping = {
        'qq.com': 'imap.qq.com',
        'vip.qq.com': 'imap.qq.com',
        'foxmail.com': 'imap.qq.com',
        '163.com': 'imap.163.com',
        '126.com': 'imap.126.com',
        'yeah.net': 'imap.yeah.net',
        'gmail.com': 'imap.gmail.com',
        'outlook.com': 'outlook.office365.com',
        'outlook.com.cn': 'outlook.office365.com',
        'hotmail.com': 'outlook.office365.com',
        'live.com': 'outlook.office365.com',
        'icloud.com': 'imap.mail.me.com',
        'proton.me': None,
    }

    if domain in mapping:
        return mapping[domain]
    return 'imap.' + domain


def fetch_otp(email_addr, auth_code, imap_host=None, imap_port=993):
    """Connect to IMAP, search INBOX + VRChat folders, return the 6-digit OTP code."""
    if imap_host is None:
        imap_host = infer_imap_host(email_addr)
        if imap_host is None:
            print(f"ERROR: {email_addr} 所属邮箱不支持 IMAP 直连（如 proton.me 需 Proton Bridge）", file=sys.stderr)
            return None

    try:
        mail = imaplib.IMAP4_SSL(imap_host, imap_port, timeout=30)
        mail.login(email_addr, auth_code)
        send_imap_id(mail)

        # 1) 先搜 INBOX（现有逻辑保留）
        mail.select('INBOX')
        msg_id = _search_mailbox(mail)
        if msg_id:
            otp = _extract_otp_from_msg(mail, msg_id)
            if otp:
                mail.logout()
                return otp

        # 2) INBOX 搜不到 → 遍历 VRChat 分类文件夹兜底
        candidate_folders = find_vrchat_folders(mail)
        for folder in candidate_folders:
            if folder == 'INBOX':
                continue
            try:
                mail.select(folder)
                msg_id = _search_mailbox(mail)
                if msg_id:
                    otp = _extract_otp_from_msg(mail, msg_id)
                    if otp:
                        mail.logout()
                        return otp
            except Exception:
                continue

        mail.logout()
        return None

    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return None


if __name__ == '__main__':
    imap_host_override = None
    if len(sys.argv) >= 4:
        addr_arg, code_arg, imap_host_override = sys.argv[1], sys.argv[2], sys.argv[3]
    elif len(sys.argv) >= 3:
        addr_arg, code_arg = sys.argv[1], sys.argv[2]
    else:
        # 自动从 Hermes .env 读凭据
        env_path = os.path.expanduser("~/AppData/Local/hermes/.env")
        try:
            env = load_env(env_path)
            addr_arg, code_arg = env.get("EMAIL_ADDRESS", ""), env.get("EMAIL_PASSWORD", "")
        except Exception as e:
            print(f"ERROR: cannot read .env ({env_path}): {e}", file=sys.stderr)
            sys.exit(1)
        if not addr_arg or not code_arg:
            print("ERROR: EMAIL_ADDRESS/EMAIL_PASSWORD missing in .env", file=sys.stderr)
            sys.exit(1)

    otp = fetch_otp(addr_arg, code_arg, imap_host=imap_host_override)
    if otp:
        print(otp)
        sys.exit(0)
    else:
        print("FAILED", file=sys.stderr)
        sys.exit(1)

# -*- coding: utf-8 -*-

from __future__ import annotations

import sys
import os
import struct
import argparse
import tempfile
from typing import Optional, Tuple

# PIL（Pillow）图像库
try:
    from PIL import Image
except Exception as e:
    print('错误：需要 Pillow (PIL)。请使用 `pip install pillow` 安装')
    raise

# 可选：加密支持
try:
    from Crypto.Cipher import AES
    from Crypto.Random import get_random_bytes
    HAS_CRYPTO = True
except Exception:
    HAS_CRYPTO = False

# GUI 可用性：尝试导入 tkinter。若缺失则使用命令行。
GUI_AVAILABLE = True
try:
    import tkinter as tk
    from tkinter import ttk, filedialog, messagebox
    from PIL import ImageTk
except Exception:
    GUI_AVAILABLE = False

# 可选拖放支持（仅当 GUI 可用时）
HAS_DND = False
if GUI_AVAILABLE:
    try:
        import tkinterdnd2
        HAS_DND = True
    except Exception:
        HAS_DND = False

HEADER_MAGIC = b'STEGv1'  # 6 字节
# 头部布局：MAGIC(6) | flags(1) | filename_len(1) | filename(N) | payload_len(8)
# flags 位：0x1 = 是文件；0x2 = 已加密

# === 工具函数 ===

def bytes_to_bits(data: bytes):
    """将字节转换为比特流（生成器）"""
    for b in data:
        for i in range(7, -1, -1):
            yield (b >> i) & 1


def bits_to_bytes(bits):
    """将比特流转换为字节"""
    b = bytearray()
    acc = 0
    c = 0
    for bit in bits:
        acc = (acc << 1) | (bit & 1)
        c += 1
        if c == 8:
            b.append(acc)
            acc = 0
            c = 0
    return bytes(b)


def calc_capacity(img: Image.Image) -> int:
    """计算图像可用于隐藏数据的最大比特数（RGB通道）"""
    w, h = img.size
    return w * h * 3  # 每个像素3个通道


def int_to_bytes64(n: int) -> bytes:
    return struct.pack('>Q', n)


def bytes64_to_int(b: bytes) -> int:
    return struct.unpack('>Q', b)[0]

# === 加密辅助函数 ===

def derive_key_from_password(password: str) -> bytes:
    """从密码派生密钥（演示用，生产环境建议使用 PBKDF2/scrypt）"""
    from hashlib import sha256
    return sha256(password.encode('utf-8')).digest()


def encrypt_payload(payload: bytes, password: str) -> bytes:
    """使用 AES-256 GCM 加密载荷"""
    if not HAS_CRYPTO:
        raise RuntimeError('需要 pycryptodome 以支持加密')
    key = derive_key_from_password(password)
    iv = get_random_bytes(12)  # GCM 推荐12字节随机数
    cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
    ciphertext, tag = cipher.encrypt_and_digest(payload)
    # 存储格式：nonce(12) + tag(16) + ciphertext
    return iv + tag + ciphertext


def decrypt_payload(enc: bytes, password: str) -> bytes:
    """解密 AES-256 GCM 加密的载荷"""
    if not HAS_CRYPTO:
        raise RuntimeError('需要 pycryptodome 以支持解密')
    key = derive_key_from_password(password)
    if len(enc) < 12 + 16:
        raise ValueError('加密载荷过短或损坏')
    iv = enc[:12]
    tag = enc[12:28]
    ciphertext = enc[28:]
    cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
    return cipher.decrypt_and_verify(ciphertext, tag)

# === LSB 嵌入与提取 ===

def _choose_mode_and_bands(img: Image.Image) -> Tuple[Image.Image, bool]:
    """将图像转为 RGB 或 RGBA，并返回是否包含 Alpha 通道"""
    bands = img.getbands()  # 例如 ('R','G','B') 或 ('R','G','B','A')
    has_alpha = 'A' in bands
    if has_alpha:
        return img.convert('RGBA'), True
    return img.convert('RGB'), False


def embed_bytes_into_image(img: Image.Image, payload: bytes) -> Image.Image:
    """
    将载荷（字节）嵌入到图像的 RGB 通道 LSB 中。
    返回新的 PIL Image 对象（模式 RGB 或 RGBA）。
    """
    img, has_alpha = _choose_mode_and_bands(img)
    pixels = list(img.getdata())
    flat = []
    if has_alpha:
        for (r, g, b, a) in pixels:
            flat.extend([r, g, b, a])
    else:
        for (r, g, b) in pixels:
            flat.extend([r, g, b])

    # 可修改的索引：仅 RGB 通道（保留 Alpha）
    mod_indices = []
    if has_alpha:
        for i in range(0, len(flat), 4):
            mod_indices.extend([i, i + 1, i + 2])
    else:
        mod_indices = list(range(len(flat)))

    capacity = len(mod_indices)
    bits = list(bytes_to_bits(payload))
    if len(bits) > capacity:
        raise ValueError(f'载荷过大：需要 {len(bits)} 位，容量为 {capacity} 位')

    flat_copy = flat[:]
    for i, bit in enumerate(bits):
        idx = mod_indices[i]
        flat_copy[idx] = (flat_copy[idx] & ~1) | bit

    # 重构像素
    new_pixels = []
    if has_alpha:
        for i in range(0, len(flat_copy), 4):
            new_pixels.append((flat_copy[i], flat_copy[i + 1], flat_copy[i + 2], flat_copy[i + 3]))
        new_img = Image.new('RGBA', img.size)
    else:
        for i in range(0, len(flat_copy), 3):
            new_pixels.append((flat_copy[i], flat_copy[i + 1], flat_copy[i + 2]))
        new_img = Image.new('RGB', img.size)

    new_img.putdata(new_pixels)
    return new_img


def extract_bytes_from_image(img: Image.Image, num_bits: int) -> bytes:
    """从图像中提取指定数量的比特，并转换为字节"""
    img, has_alpha = _choose_mode_and_bands(img)
    pixels = list(img.getdata())
    flat = []
    if has_alpha:
        for (r, g, b, a) in pixels:
            flat.extend([r, g, b, a])
    else:
        for (r, g, b) in pixels:
            flat.extend([r, g, b])

    mod_indices = []
    if has_alpha:
        for i in range(0, len(flat), 4):
            mod_indices.extend([i, i + 1, i + 2])
    else:
        mod_indices = list(range(len(flat)))

    bits = []
    for i in range(min(num_bits, len(mod_indices))):
        bits.append(flat[mod_indices[i]] & 1)
    return bits_to_bytes(bits)

# === 组装头部与载荷 ===

def make_stego_payload(payload: bytes, is_file: bool, filename: Optional[str], encrypt: bool, password: Optional[str]) -> bytes:
    """构造完整的隐写载荷（头部 + 载荷数据）"""
    flags = 0
    if is_file:
        flags |= 0x1
    data = payload
    if encrypt:
        if password is None:
            raise ValueError('加密时需提供密码')
        flags |= 0x2
        data = encrypt_payload(payload, password)
    name_bytes = filename.encode('utf-8') if (filename and is_file) else b''
    if len(name_bytes) > 255:
        raise ValueError('文件名过长（最大 255 字节）')
    header = HEADER_MAGIC + bytes([flags]) + bytes([len(name_bytes)]) + name_bytes + int_to_bytes64(len(data))
    return header + data


def parse_stego_header(stream_bytes: bytes):
    """解析隐写头部，返回元数据字典"""
    if len(stream_bytes) < 6 + 1 + 1 + 8:
        raise ValueError('头部过小')
    if stream_bytes[:6] != HEADER_MAGIC:
        raise ValueError('未找到魔数标识')
    flags = stream_bytes[6]
    name_len = stream_bytes[7]
    pos = 8
    filename = None
    if name_len:
        filename = stream_bytes[pos:pos + name_len].decode('utf-8')
    pos += name_len
    payload_len = bytes64_to_int(stream_bytes[pos:pos + 8])
    pos += 8
    return {
        'flags': flags,
        'is_file': bool(flags & 0x1),
        'encrypted': bool(flags & 0x2),
        'filename': filename,
        'payload_len': payload_len,
        'header_size': pos,
    }

# === 基于文件的辅助函数（GUI 和 CLI 共用） ===

def embed_to_image_file(in_path: str, out_path: str, payload: bytes, is_file: bool = False, filename: Optional[str] = None, encrypt: bool = False, password: Optional[str] = None) -> str:
    """将载荷嵌入到图像文件并保存"""
    img = Image.open(in_path)
    stego = make_stego_payload(payload, is_file, filename, encrypt, password)
    cap = calc_capacity(img)
    if len(stego) * 8 > cap:
        raise ValueError(f'载荷+头部过大：需要 {len(stego)*8} 位，容量 {cap} 位')
    out_img = embed_bytes_into_image(img, stego)
    # 始终保存为 PNG 以保留无损数据
    out_img.save(out_path, format='PNG')
    return out_path


def extract_from_image_file(in_path: str, password: Optional[str] = None) -> Tuple[dict, bytes]:
    """从图像文件中提取载荷，返回元数据和载荷数据"""
    img = Image.open(in_path)
    header_max_len = 6 + 1 + 1 + 255 + 8
    header_bytes = extract_bytes_from_image(img, header_max_len * 8)
    meta = parse_stego_header(header_bytes)
    total_bits = (meta['header_size'] + meta['payload_len']) * 8
    all_bytes = extract_bytes_from_image(img, total_bits)
    payload_bytes = all_bytes[meta['header_size']:meta['header_size'] + meta['payload_len']]
    if meta['encrypted']:
        if not password:
            raise ValueError('载荷已加密，需提供密码')
        payload_bytes = decrypt_payload(payload_bytes, password)
    return meta, payload_bytes

# === 简单命令行界面 ===

def run_cli(argv=None):
    p = argparse.ArgumentParser(prog='steg-ui', description='图像隐写工具（命令行模式）')
    sub = p.add_subparsers(dest='cmd', required=True)

    # 嵌入子命令
    e = sub.add_parser('embed', help='将文本或文件嵌入图像')
    e.add_argument('--in', dest='infile', required=True, help='载体图像（推荐 PNG/BMP）')
    e.add_argument('--out', dest='outfile', required=True, help='输出隐写图像（PNG）')
    g = e.add_mutually_exclusive_group(required=True)
    g.add_argument('--text', dest='text', help='要嵌入的文本消息')
    g.add_argument('--file', dest='file', help='要嵌入的文件路径')
    e.add_argument('--encrypt', action='store_true', help='加密载荷（AES-GCM）')
    e.add_argument('--password', help='加密密码')

    # 提取子命令
    x = sub.add_parser('extract', help='从隐写图像中提取载荷')
    x.add_argument('--in', dest='infile', required=True, help='隐写图像')
    x.add_argument('--out', dest='outfile', help='输出路径（提取文件时使用）。若不指定且载荷为文本，则打印到控制台。')
    x.add_argument('--password', help='密码（若载荷已加密）')

    # 容量查询子命令
    c = sub.add_parser('capacity', help='显示图像的近似容量')
    c.add_argument('--in', dest='infile', required=True, help='图像文件')

    # 自检子命令
    s = sub.add_parser('selftest', help='运行基本自检（嵌入+提取）')

    args = p.parse_args(argv)

    try:
        if args.cmd == 'embed':
            if args.text:
                payload = args.text.encode('utf-8')
                is_file = False
                filename = None
            else:
                with open(args.file, 'rb') as f:
                    payload = f.read()
                is_file = True
                filename = os.path.basename(args.file)
            if args.encrypt and not HAS_CRYPTO:
                print('错误：请求加密但未安装 pycryptodome')
                return 2
            if args.encrypt and not args.password:
                print('错误：使用 --encrypt 时必须提供 --password')
                return 2
            embed_to_image_file(args.infile, args.outfile, payload, is_file, filename, args.encrypt, args.password)
            print(f'成功：载荷已嵌入到 {args.outfile}')
            return 0

        if args.cmd == 'extract':
            meta, payload = extract_from_image_file(args.infile, args.password)
            if meta['is_file']:
                outp = args.outfile or meta.get('filename') or 'extracted_payload'
                with open(outp, 'wb') as f:
                    f.write(payload)
                print(f'成功：提取的文件已保存为 {outp}')
            else:
                if args.outfile:
                    with open(args.outfile, 'wb') as f:
                        f.write(payload)
                    print(f'成功：提取的文本已保存到 {args.outfile}')
                else:
                    print('--- 提取的文本开始 ---')
                    print(payload.decode('utf-8', errors='replace'))
                    print('--- 提取的文本结束 ---')
            return 0

        if args.cmd == 'capacity':
            img = Image.open(args.infile)
            cap = calc_capacity(img)
            print(f'容量：{cap} 位（{cap//8} 字节）')
            return 0

        if args.cmd == 'selftest':
            return run_selftest()

    except Exception as e:
        print('错误：', e)
        return 1


def run_selftest() -> int:
    print('正在运行自检：嵌入并提取一段短文本载荷...')
    try:
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as t:
            tmpname = t.name
        # 创建一张小尺寸载体图像
        img = Image.new('RGB', (128, 128), color=(123, 222, 100))
        img.save(tmpname)
        message = "Hello world — steg selftest".encode("utf-8")

        outpath = tmpname + '.stego.png'
        embed_to_image_file(tmpname, outpath, message, is_file=False, filename=None, encrypt=False, password=None)
        meta, extracted = extract_from_image_file(outpath, password=None)
        if extracted != message:
            print('自检失败：提取的载荷与原始消息不符')
            return 2
        print('自检通过（明文载荷）')

        if HAS_CRYPTO:
            print('正在运行加密自检（AES-GCM）...')
            outpath_enc = tmpname + '.stego.enc.png'
            pwd = 'testpass'
            embed_to_image_file(tmpname, outpath_enc, message, is_file=False, filename=None, encrypt=True, password=pwd)
            meta2, extracted2 = extract_from_image_file(outpath_enc, password=pwd)
            if extracted2 != message:
                print('加密自检失败')
                return 3
            print('加密自检通过')
        else:
            print('跳过加密自检（未安装 pycryptodome）')

        # 清理临时文件
        try:
            os.remove(tmpname)
            os.remove(outpath)
            if HAS_CRYPTO:
                os.remove(outpath_enc)
        except Exception:
            pass
        print('所有自检通过')
        return 0
    except Exception as e:
        print('自检错误：', e)
        return 4

# === 图形界面（仅当 tkinter 可用时） ===

if GUI_AVAILABLE:
    class StegApp:
        def __init__(self, root):
            self.root = root
            root.title('StegUI — 图像隐写工具')
            self.mainframe = ttk.Frame(root, padding=10)
            self.mainframe.grid(sticky='nsew')
            root.rowconfigure(0, weight=1)
            root.columnconfigure(0, weight=1)

            # 变量
            self.input_image_path = tk.StringVar()
            self.output_image_path = tk.StringVar()
            self.embed_text = tk.StringVar()
            self.embed_file_path = tk.StringVar()
            self.password = tk.StringVar()
            self.encrypt_var = tk.BooleanVar(value=False)
            self.is_file_var = tk.BooleanVar(value=False)

            # 构建界面
            self._build_widgets()

            # 预览标签
            self.preview_label = None
            self.loaded_image = None

        def _build_widgets(self):
            row = 0
            ttk.Label(self.mainframe, text='输入图像（推荐 PNG/BMP）：').grid(column=0, row=row, sticky='w')
            row += 1
            inframe = ttk.Frame(self.mainframe)
            inframe.grid(column=0, row=row, sticky='ew')
            inframe.columnconfigure(0, weight=1)
            ttk.Entry(inframe, textvariable=self.input_image_path).grid(column=0, row=0, sticky='ew')
            ttk.Button(inframe, text='浏览', command=self.browse_input_image).grid(column=1, row=0)
            ttk.Button(inframe, text='预览', command=self.preview_image).grid(column=2, row=0)
            row += 1

            ttk.Separator(self.mainframe, orient='horizontal').grid(column=0, row=row, sticky='ew', pady=8)
            row += 1

            ttk.Label(self.mainframe, text='载荷类型：').grid(column=0, row=row, sticky='w')
            row += 1
            tframe = ttk.Frame(self.mainframe)
            tframe.grid(column=0, row=row, sticky='ew')
            ttk.Radiobutton(tframe, text='文本', variable=self.is_file_var, value=False).grid(column=0, row=0)
            ttk.Radiobutton(tframe, text='文件', variable=self.is_file_var, value=True).grid(column=1, row=0)
            row += 1

            # 文本载荷
            ttk.Label(self.mainframe, text='文本消息：').grid(column=0, row=row, sticky='w')
            row += 1
            ttk.Entry(self.mainframe, textvariable=self.embed_text, width=80).grid(column=0, row=row, sticky='ew')
            row += 1

            # 文件载荷
            fframe = ttk.Frame(self.mainframe)
            fframe.grid(column=0, row=row, sticky='ew')
            ttk.Entry(fframe, textvariable=self.embed_file_path).grid(column=0, row=0, sticky='ew')
            ttk.Button(fframe, text='浏览', command=self.browse_payload_file).grid(column=1, row=0)
            row += 1

            ttk.Separator(self.mainframe, orient='horizontal').grid(column=0, row=row, sticky='ew', pady=8)
            row += 1

            # 加密选项
            ttk.Checkbutton(self.mainframe, text='加密载荷（AES-256 GCM）', variable=self.encrypt_var).grid(column=0, row=row, sticky='w')
            row += 1
            ttk.Label(self.mainframe, text='密码（加密时必填）：').grid(column=0, row=row, sticky='w')
            row += 1
            ttk.Entry(self.mainframe, textvariable=self.password, show='*').grid(column=0, row=row, sticky='ew')
            row += 1

            # 输出
            ttk.Label(self.mainframe, text='输出图像路径：').grid(column=0, row=row, sticky='w')
            row += 1
            outframe = ttk.Frame(self.mainframe)
            outframe.grid(column=0, row=row, sticky='ew')
            ttk.Entry(outframe, textvariable=self.output_image_path).grid(column=0, row=0, sticky='ew')
            ttk.Button(outframe, text='浏览', command=self.browse_output_image).grid(column=1, row=0)
            row += 1

            # 操作按钮
            btnframe = ttk.Frame(self.mainframe)
            btnframe.grid(column=0, row=row, sticky='ew', pady=10)
            ttk.Button(btnframe, text='嵌入', command=self.do_embed).grid(column=0, row=0, padx=5)
            ttk.Button(btnframe, text='提取', command=self.do_extract).grid(column=1, row=0, padx=5)
            ttk.Button(btnframe, text='容量信息', command=self.show_capacity).grid(column=2, row=0, padx=5)
            row += 1

            # 状态栏
            self.status = tk.StringVar(value='就绪')
            ttk.Label(self.mainframe, textvariable=self.status).grid(column=0, row=row, sticky='w')

        def browse_input_image(self):
            p = filedialog.askopenfilename(filetypes=[('图像', '*.png *.bmp'), ('所有文件', '*.*')])
            if p:
                self.input_image_path.set(p)

        def browse_output_image(self):
            p = filedialog.asksaveasfilename(defaultextension='.png', filetypes=[('PNG', '*.png'), ('BMP', '*.bmp')])
            if p:
                self.output_image_path.set(p)

        def browse_payload_file(self):
            p = filedialog.askopenfilename()
            if p:
                self.embed_file_path.set(p)
                self.is_file_var.set(True)

        def preview_image(self):
            p = self.input_image_path.get()
            if not p or not os.path.exists(p):
                messagebox.showerror('错误', '请选择有效的输入图像')
                return
            try:
                img = Image.open(p)
                self.loaded_image = img.copy()
                img.thumbnail((400, 400))
                tkimg = ImageTk.PhotoImage(img)
                if getattr(self, 'preview_label', None) is None:
                    self.preview_label = ttk.Label(self.mainframe, image=tkimg)
                    self.preview_label.image = tkimg
                    self.preview_label.grid(column=0, row=999, pady=8)
                else:
                    self.preview_label.configure(image=tkimg)
                    self.preview_label.image = tkimg
            except Exception as e:
                messagebox.showerror('错误', f'无法预览图像：{e}')

        def show_capacity(self):
            p = self.input_image_path.get()
            if not p or not os.path.exists(p):
                messagebox.showinfo('容量', '请先选择输入图像')
                return
            img = Image.open(p)
            cap = calc_capacity(img)
            messagebox.showinfo('容量', f'近似可用容量：{cap} 位（{cap//8} 字节）')

        def do_embed(self):
            inpath = self.input_image_path.get()
            outpath = self.output_image_path.get()
            if not inpath or not os.path.exists(inpath):
                messagebox.showerror('错误', '输入图像不存在')
                return
            if not outpath:
                messagebox.showerror('错误', '请选择输出路径')
                return
            is_file = self.is_file_var.get()
            encrypt = self.encrypt_var.get()
            pwd = self.password.get() if encrypt else None
            if encrypt and not pwd:
                messagebox.showerror('错误', '已选择加密但未提供密码')
                return
            if is_file:
                fp = self.embed_file_path.get()
                if not fp or not os.path.exists(fp):
                    messagebox.showerror('错误', '请选择要嵌入的文件')
                    return
                with open(fp, 'rb') as f:
                    payload = f.read()
                filename = os.path.basename(fp)
            else:
                text = self.embed_text.get() or ''
                payload = text.encode('utf-8')
                filename = None
            try:
                embed_to_image_file(inpath, outpath, payload, is_file=is_file, filename=filename, encrypt=encrypt, password=pwd)
                self.status.set(f'已嵌入 — 保存至 {outpath}')
                messagebox.showinfo('成功', f'载荷已嵌入并保存到 {outpath}')
            except Exception as e:
                messagebox.showerror('错误', f'嵌入失败：{e}')

        def do_extract(self):
            inpath = self.input_image_path.get()
            if not inpath or not os.path.exists(inpath):
                messagebox.showerror('错误', '输入图像不存在')
                return
            try:
                pwd = self.password.get() or None
                meta, payload = extract_from_image_file(inpath, password=pwd)
                if meta['is_file']:
                    suggested = meta.get('filename') or 'extracted_payload'
                    savep = filedialog.asksaveasfilename(initialfile=suggested)
                    if not savep:
                        messagebox.showinfo('已取消', '保存操作已取消')
                        return
                    with open(savep, 'wb') as f:
                        f.write(payload)
                    messagebox.showinfo('成功', f'提取的文件已保存到 {savep}')
                else:
                    text = payload.decode('utf-8', errors='replace')
                    top = tk.Toplevel(self.root)
                    top.title('提取的消息内容')
                    txt = tk.Text(top, wrap='word', width=80, height=20)
                    txt.pack(expand=True, fill='both')
                    txt.insert('1.0', text)
                self.status.set('提取完成')
            except Exception as e:
                messagebox.showerror('错误', f'提取失败：{e}')

    def run_gui():
        root = tk.Tk()
        app = StegApp(root)
        root.mainloop()

# === 入口点 ===

def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    # 若 GUI 可用且未指定任何命令行参数，则启动 GUI
    if GUI_AVAILABLE and (len(argv) == 0):
        try:
            run_gui()
            return 0
        except Exception as e:
            print('启动 GUI 失败，回退到命令行模式：', e)
    # 否则运行 CLI
    return run_cli(argv)


if __name__ == '__main__':
    rc = main()
    sys.exit(rc)

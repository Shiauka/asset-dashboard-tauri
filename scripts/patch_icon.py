"""
After `npm run build`, run this script to embed channel_cover.png into the exe.
Usage: python scripts/patch_icon.py
"""
import ctypes, struct, os, sys

EXE = os.path.join(os.path.dirname(__file__), r'..\src-tauri\target\release\asset-dashboard.exe')
ICO = os.path.join(os.path.dirname(__file__), r'..\src-tauri\icons\icon.ico')
EXE = os.path.normpath(EXE)
ICO = os.path.normpath(ICO)

if not os.path.exists(EXE):
    print(f'EXE not found: {EXE}'); sys.exit(1)
if not os.path.exists(ICO):
    print(f'ICO not found: {ICO}'); sys.exit(1)

k32 = ctypes.windll.kernel32
HANDLE = ctypes.c_void_p
k32.BeginUpdateResourceW.restype  = HANDLE
k32.BeginUpdateResourceW.argtypes = [ctypes.c_wchar_p, ctypes.c_bool]
k32.UpdateResourceW.restype  = ctypes.c_bool
k32.UpdateResourceW.argtypes = [HANDLE, HANDLE, HANDLE, ctypes.c_uint16, ctypes.c_void_p, ctypes.c_uint32]
k32.EndUpdateResourceW.restype  = ctypes.c_bool
k32.EndUpdateResourceW.argtypes = [HANDLE, ctypes.c_bool]

with open(ICO, 'rb') as f:
    ico = f.read()
count = struct.unpack_from('<H', ico, 4)[0]
images = []
for i in range(count):
    off = 6 + i * 16
    w, h, cc, _, planes, bpp, size, offset = struct.unpack_from('<BBBBHHiI', ico, off)
    images.append((w, h, cc, planes, bpp, size, ico[offset:offset+size]))

grp = struct.pack('<HHH', 0, 1, count)
for idx, (w, h, cc, planes, bpp, size, _) in enumerate(images, start=1):
    grp += struct.pack('<BBBBHHiH', w, h, cc, 0, planes, bpp, size, idx)

h = k32.BeginUpdateResourceW(EXE, False)
if not h:
    print(f'BeginUpdateResource failed: {k32.GetLastError()}'); sys.exit(1)

ok = True
for idx, (_, _, _, _, _, size, data) in enumerate(images, start=1):
    buf = ctypes.create_string_buffer(bytes(data))
    if not k32.UpdateResourceW(h, 3, idx, 0, buf, len(data)):
        print(f'RT_ICON {idx} failed: {k32.GetLastError()}'); ok = False; break

if ok:
    grp_bytes = bytes(grp)
    buf2 = ctypes.create_string_buffer(grp_bytes)
    if not k32.UpdateResourceW(h, 14, 1, 0, buf2, len(grp_bytes)):
        print(f'RT_GROUP_ICON failed: {k32.GetLastError()}'); ok = False

k32.EndUpdateResourceW(h, not ok)
if ok:
    print(f'Icon embedded: {EXE}')
else:
    sys.exit(1)

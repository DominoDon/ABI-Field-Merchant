// ABI Field Merchant Companion - native host
// - Serves the web app on http://127.0.0.1:5173 (no Node.js needed)
// - /api/devices  : JSON list of active OUTPUT (render) devices
// - /api/loopback : raw mono float32 PCM stream captured via WASAPI loopback from a chosen
//                   output device (e.g. FiiO DAC or SteelSeries Sonar - Gaming). This is the
//                   exact digital signal going to that device: no microphone, no room noise,
//                   no screen-share prompt.
// - Opens the app in a dedicated Chrome/Edge --app window with background throttling disabled.
// - Lives in the system tray (right-click > Exit).
//
// Build: powershell -ExecutionPolicy Bypass -File tools/build.ps1  (embeds the web files + icon -> ABI-Field-Merchant.exe)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("ABI Field Merchant")]
[assembly: System.Reflection.AssemblyProduct("ABI Field Merchant")]
[assembly: System.Reflection.AssemblyDescription("Arena Breakout: Infinite Field Merchant crate sound decoder")]
[assembly: System.Reflection.AssemblyVersion("2.1.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("2.1.0.0")]

namespace ABIFieldMerchant
{
    // ------------------------------------------------------------------ WASAPI COM interop
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorCom { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice endpoint);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int stgmAccess, out IPropertyStore props);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int iProp, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant pv);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant pv);
        [PreserveSig] int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Explicit)]
    struct PropVariant
    {
        [FieldOffset(0)] public short vt;
        [FieldOffset(8)] public IntPtr pointer;
        [FieldOffset(16)] public IntPtr pad;
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defPeriod, out long minPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out int frames, out int flags, out long devPos, out long qpcPos);
        [PreserveSig] int ReleaseBuffer(int frames);
        [PreserveSig] int GetNextPacketSize(out int frames);
    }

    // ---- Process loopback (Windows 10 2004+): capture audio of ONE process tree only
    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int hr, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Hr; public object Iface;
        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation op)
        {
            try { op.GetActivateResult(out Hr, out Iface); } catch (Exception e) { Hr = Marshal.GetHRForException(e); }
            Done.Set();
        }
    }

    class AudioDeviceInfo { public string Id; public string Name; public bool IsDefault; }

    // ------------------------------------------------------------------ Text reading (Windows built-in OCR)
    static class TextReader
    {
        static Windows.Media.Ocr.OcrEngine engine;
        static readonly object gate = new object();

        public static bool Available() { try { return Engine() != null; } catch { return false; } }

        static Windows.Media.Ocr.OcrEngine Engine()
        {
            if (engine == null)
            {
                engine = Windows.Media.Ocr.OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-US"))
                         ?? Windows.Media.Ocr.OcrEngine.TryCreateFromUserProfileLanguages();
                if (engine == null) throw new Exception("Windows OCR is not available (no English OCR language installed)");
            }
            return engine;
        }

        // Reads text in a bitmap; small text is enlarged first (Windows OCR prefers ~20+ px tall letters).
        // Returns JSON { lines: [ { text, x, y, w, h, words: [ { text, x, y, w, h } ] } ] } in source-bitmap pixels.
        public static string Read(Bitmap src, double upscale)
        {
            int w = Math.Max(1, (int)(src.Width * upscale)), h = Math.Max(1, (int)(src.Height * upscale));
            using (var bmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawImage(src, 0, 0, w, h);
                }
                var data = bmp.LockBits(new Rectangle(0, 0, w, h), System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                byte[] bytes = new byte[data.Stride * h];
                Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
                bmp.UnlockBits(data);
                var sb = Windows.Graphics.Imaging.SoftwareBitmap.CreateCopyFromBuffer(
                    Windows.Security.Cryptography.CryptographicBuffer.CreateFromByteArray(bytes),
                    Windows.Graphics.Imaging.BitmapPixelFormat.Bgra8, w, h, Windows.Graphics.Imaging.BitmapAlphaMode.Premultiplied);
                Windows.Media.Ocr.OcrResult result;
                lock (gate)
                {
                    var op = Engine().RecognizeAsync(sb);
                    var until = DateTime.UtcNow.AddSeconds(5);
                    while (op.Status == Windows.Foundation.AsyncStatus.Started)
                    {
                        if (DateTime.UtcNow > until) { op.Cancel(); throw new Exception("OCR timed out"); }
                        Thread.Sleep(2);
                    }
                    if (op.Status != Windows.Foundation.AsyncStatus.Completed) throw new Exception("OCR failed: " + op.Status);
                    result = op.GetResults();
                }
                var json = new StringBuilder("{\"lines\":[");
                bool firstLine = true;
                foreach (var line in result.Lines)
                {
                    double lx = 1e9, ly = 1e9, lr = 0, lb = 0;
                    var words = new StringBuilder();
                    bool firstWord = true;
                    foreach (var word in line.Words)
                    {
                        var r = word.BoundingRect;
                        double x = (double)r.X / upscale, y = (double)r.Y / upscale, ww = (double)r.Width / upscale, hh = (double)r.Height / upscale;
                        lx = Math.Min(lx, x); ly = Math.Min(ly, y); lr = Math.Max(lr, x + ww); lb = Math.Max(lb, y + hh);
                        if (!firstWord) words.Append(',');
                        firstWord = false;
                        words.Append("{\"text\":\"").Append(Json(word.Text)).Append("\",\"x\":").Append((int)x).Append(",\"y\":").Append((int)y)
                             .Append(",\"w\":").Append((int)ww).Append(",\"h\":").Append((int)hh).Append('}');
                    }
                    if (!firstLine) json.Append(',');
                    firstLine = false;
                    json.Append("{\"text\":\"").Append(Json(line.Text)).Append("\",\"x\":").Append((int)lx).Append(",\"y\":").Append((int)ly)
                        .Append(",\"w\":").Append((int)(lr - lx)).Append(",\"h\":").Append((int)(lb - ly)).Append(",\"words\":[").Append(words).Append("]}");
                }
                json.Append("]}");
                return json.ToString();
            }
        }

        static string Json(string s)
        {
            var sb = new StringBuilder();
            foreach (char c in s ?? "") { if (c == '"' || c == '\\') sb.Append('\\').Append(c); else if (c < 0x20) sb.Append(' '); else sb.Append(c); }
            return sb.ToString();
        }
    }

    // ------------------------------------------------------------------ Game window picture
    // A plain screen copy of the game window's client area (works in borderless window mode, like a screen
    // recorder; the game process is never opened or read).
    static class Screen
    {
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        delegate bool EnumProc(IntPtr h, IntPtr p);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);

        static IntPtr cached = IntPtr.Zero; static int cachedPid = 0;

        public static IntPtr GameWindow()
        {
            int pid = Wasapi.FindGamePid();
            if (pid == 0) return IntPtr.Zero;
            RECT tmp;
            if (pid == cachedPid && cached != IntPtr.Zero && IsWindowVisible(cached) && GetClientRect(cached, out tmp)) return cached;
            IntPtr best = IntPtr.Zero; long bestArea = 0;
            EnumWindows((h, p) =>
            {
                uint owner; GetWindowThreadProcessId(h, out owner);
                RECT r;
                if (owner == pid && IsWindowVisible(h) && GetClientRect(h, out r))
                {
                    long area = (long)(r.R - r.L) * (r.B - r.T);
                    if (area > bestArea) { bestArea = area; best = h; }
                }
                return true;
            }, IntPtr.Zero);
            cached = best; cachedPid = pid;
            return best;
        }

        // Client area in screen pixels, or null (no game / minimised)
        public static Rectangle? ClientArea(IntPtr h)
        {
            if (h == IntPtr.Zero || IsIconic(h)) return null;
            RECT r; if (!GetClientRect(h, out r)) return null;
            var p = new POINT(); ClientToScreen(h, ref p);
            if (r.R - r.L < 100 || r.B - r.T < 100) return null;
            return new Rectangle(p.X, p.Y, r.R - r.L, r.B - r.T);
        }

        [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
        [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);

        // Is the mouse cursor shown? (hidden while aiming in a raid, shown in menus like the merchant)
        static bool CursorShown()
        {
            var ci = new CURSORINFO { cbSize = Marshal.SizeOf(typeof(CURSORINFO)) };
            return GetCursorInfo(ref ci) && (ci.flags & 1) != 0;
        }

        public static string StateJson()
        {
            IntPtr h = GameWindow();
            var area = ClientArea(h);
            POINT c; GetCursorPos(out c);
            bool lmb = (GetAsyncKeyState(0x01) & 0x8000) != 0;
            string cur = CursorShown() ? "true" : "false";
            if (area == null) return "{\"game\":false,\"cx\":" + c.X + ",\"cy\":" + c.Y + ",\"lmb\":" + (lmb ? "true" : "false") + ",\"cursor\":" + cur + "}";
            var a = area.Value;
            return "{\"game\":true,\"x\":" + a.X + ",\"y\":" + a.Y + ",\"w\":" + a.Width + ",\"h\":" + a.Height +
                   ",\"cx\":" + (c.X - a.X) + ",\"cy\":" + (c.Y - a.Y) + ",\"lmb\":" + (lmb ? "true" : "false") +
                   ",\"cursor\":" + cur + ",\"focused\":" + (GetForegroundWindow() == h ? "true" : "false") + "}";
        }

        // Region of the client area in client pixels -> bitmap (caller disposes), or null without a game window
        public static Bitmap GrabClient(int cx, int cy, int cw, int ch)
        {
            var area = ClientArea(GameWindow());
            if (area == null) return null;
            var a = area.Value;
            cx = Math.Max(0, Math.Min(a.Width - 8, cx)); cy = Math.Max(0, Math.Min(a.Height - 8, cy));
            cw = Math.Max(8, Math.Min(a.Width - cx, cw)); ch = Math.Max(8, Math.Min(a.Height - cy, ch));
            var bmp = new Bitmap(cw, ch, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
            using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(a.X + cx, a.Y + cy, 0, 0, new Size(cw, ch), CopyPixelOperation.SourceCopy);
            return bmp;
        }

        // Region of the client area given as fractions (0..1). Returns encoded image bytes or null.
        public static byte[] Capture(double fx, double fy, double fw, double fh, double scale, bool png, out string meta)
        {
            meta = null;
            var area = ClientArea(GameWindow());
            if (area == null) return null;
            var a = area.Value;
            int x = a.X + (int)(a.Width * fx), y = a.Y + (int)(a.Height * fy);
            int w = Math.Max(16, (int)(a.Width * fw)), h = Math.Max(16, (int)(a.Height * fh));
            using (var bmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppRgb))
            {
                using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
                Bitmap outBmp = bmp;
                if (scale > 0 && scale < 1)
                {
                    outBmp = new Bitmap(bmp, new Size(Math.Max(16, (int)(w * scale)), Math.Max(16, (int)(h * scale))));
                }
                try
                {
                    using (var ms = new MemoryStream())
                    {
                        if (png) outBmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                        else
                        {
                            var enc = Array.Find(System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders(), e => e.MimeType == "image/jpeg");
                            var ps = new System.Drawing.Imaging.EncoderParameters(1);
                            ps.Param[0] = new System.Drawing.Imaging.EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 90L);
                            outBmp.Save(ms, enc, ps);
                        }
                        meta = a.X + "," + a.Y + "," + a.Width + "," + a.Height + "," + x + "," + y + "," + w + "," + h;
                        return ms.ToArray();
                    }
                }
                finally { if (outBmp != bmp) outBmp.Dispose(); }
            }
        }
    }

    static class Wasapi
    {
        static PropertyKey PKEY_FriendlyName = new PropertyKey { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };

        static string FriendlyName(IMMDevice dev)
        {
            IPropertyStore store;
            if (dev.OpenPropertyStore(0, out store) != 0 || store == null) return "Unknown device";
            PropVariant pv;
            if (store.GetValue(ref PKEY_FriendlyName, out pv) != 0) return "Unknown device";
            string name = pv.vt == 31 ? Marshal.PtrToStringUni(pv.pointer) : "Unknown device";
            Marshal.ReleaseComObject(store);
            return name;
        }

        public static List<AudioDeviceInfo> ListRenderDevices()
        {
            var list = new List<AudioDeviceInfo>();
            var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            string defId = null;
            IMMDevice def;
            if (en.GetDefaultAudioEndpoint(0, 0, out def) == 0 && def != null) { def.GetId(out defId); Marshal.ReleaseComObject(def); }
            IMMDeviceCollection col;
            if (en.EnumAudioEndpoints(0, 1, out col) == 0)
            {
                int n; col.GetCount(out n);
                for (int i = 0; i < n; i++)
                {
                    IMMDevice d; if (col.Item(i, out d) != 0) continue;
                    string id; d.GetId(out id);
                    list.Add(new AudioDeviceInfo { Id = id, Name = FriendlyName(d), IsDefault = id == defId });
                    Marshal.ReleaseComObject(d);
                }
                Marshal.ReleaseComObject(col);
            }
            Marshal.ReleaseComObject(en);
            return list;
        }

        static readonly Guid FLOAT_SUBTYPE = new Guid("00000003-0000-0010-8000-00aa00389b71");

        // Streams mono float32 LE samples to `sink` until it throws (client disconnected) or the device dies.
        public static void CaptureLoopback(string deviceId, Action<int> onFormat, Func<byte[], int, bool> sink)
        {
            var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            IMMDevice dev = null;
            int hr = string.IsNullOrEmpty(deviceId) ? en.GetDefaultAudioEndpoint(0, 0, out dev) : en.GetDevice(deviceId, out dev);
            if (hr != 0 || dev == null) throw new Exception("Output device not found (0x" + hr.ToString("X8") + ")");

            Guid iidClient = typeof(IAudioClient).GUID;
            object o;
            hr = dev.Activate(ref iidClient, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out o);
            if (hr != 0) throw new Exception("Activate failed 0x" + hr.ToString("X8"));
            var client = (IAudioClient)o;

            IntPtr fmt;
            client.GetMixFormat(out fmt);
            int tag = Marshal.ReadInt16(fmt, 0) & 0xFFFF;
            int channels = Marshal.ReadInt16(fmt, 2);
            int rate = Marshal.ReadInt32(fmt, 4);
            int blockAlign = Marshal.ReadInt16(fmt, 12);
            int bits = Marshal.ReadInt16(fmt, 14);
            bool isFloat = tag == 3;
            if (tag == 0xFFFE)
            {
                byte[] g = new byte[16];
                Marshal.Copy(new IntPtr(fmt.ToInt64() + 24), g, 0, 16);
                isFloat = new Guid(g) == FLOAT_SUBTYPE;
            }

            hr = client.Initialize(0 /*shared*/, 0x00020000 /*LOOPBACK*/, 2000000 /*200ms*/, 0, fmt, IntPtr.Zero);
            Marshal.FreeCoTaskMem(fmt);
            if (hr != 0) throw new Exception("Initialize failed 0x" + hr.ToString("X8"));

            Guid iidCapture = typeof(IAudioCaptureClient).GUID;
            client.GetService(ref iidCapture, out o);
            var capture = (IAudioCaptureClient)o;

            try
            {
                onFormat(rate);
                Pump(client, capture, channels, bits, blockAlign, isFloat, null, sink);
            }
            finally
            {
                Marshal.ReleaseComObject(capture);
                Marshal.ReleaseComObject(client);
                Marshal.ReleaseComObject(dev);
                Marshal.ReleaseComObject(en);
            }
        }

        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
        static extern void ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        // ---- Finding the game WITHOUT touching it ------------------------------------------------
        // The game process is never opened (no OpenProcess / process handle of any kind): we only read the
        // system's process list (names + ids, like Task Manager's list) and the desktop's window list.
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct PROCESSENTRY32W
        {
            public int dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID;
            public int th32ModuleID, cntThreads, th32ParentProcessID, pcPriClassBase, dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
        }
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        delegate bool EnumWinProc(IntPtr h, IntPtr p);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWinProc cb, IntPtr p);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out Screen.RECT r);

        // Ids of running processes with this exe name, from the system process list (TH32CS_SNAPPROCESS)
        static List<int> ProcessIdsByName(string exe)
        {
            var ids = new List<int>();
            IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
            if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return ids;
            try
            {
                var e = new PROCESSENTRY32W { dwSize = Marshal.SizeOf(typeof(PROCESSENTRY32W)) };
                for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e))
                    if (string.Equals(e.szExeFile, exe, StringComparison.OrdinalIgnoreCase)) ids.Add(e.th32ProcessID);
            }
            finally { CloseHandle(snap); }
            return ids;
        }

        // Arena Breakout: Infinite's game client process. Returns 0 if not running.
        static int cachedGamePid; static DateTime cachedGameAt = DateTime.MinValue;

        // cached for 2 s: the page asks several times a second
        public static int FindGamePid()
        {
            if ((DateTime.UtcNow - cachedGameAt).TotalSeconds < 2) return cachedGamePid;
            cachedGamePid = FindGamePidNow(); cachedGameAt = DateTime.UtcNow;
            return cachedGamePid;
        }

        static int FindGamePidNow()
        {
            var ids = ProcessIdsByName((Environment.GetEnvironmentVariable("ABI_GAME_PROCESS") ?? "UAGame") + ".exe");
            if (ids.Count <= 1) return ids.Count == 1 ? ids[0] : 0;
            // several: the one that owns the biggest visible window (window list only)
            int best = ids[0]; long bestArea = -1;
            EnumWindows((h, p) =>
            {
                uint owner; GetWindowThreadProcessId(h, out owner);
                Screen.RECT r;
                if (ids.Contains((int)owner) && IsWindowVisible(h) && GetClientRect(h, out r))
                {
                    long area = (long)(r.R - r.L) * (r.B - r.T);
                    if (area > bestArea) { bestArea = area; best = (int)owner; }
                }
                return true;
            }, IntPtr.Zero);
            return best;
        }

        // Captures ONLY the audio rendered by process `pid` (and its children), on any output device.
        public static void CaptureProcess(int pid, Action<int> onFormat, Func<byte[], int, bool> sink)
        {
            const int rate = 48000, channels = 2, bits = 32, blockAlign = 8;
            // AUDIOCLIENT_ACTIVATION_PARAMS { PROCESS_LOOPBACK=1, { pid, INCLUDE_TARGET_PROCESS_TREE=0 } }
            IntPtr parms = Marshal.AllocHGlobal(12);
            Marshal.WriteInt32(parms, 0, 1);
            Marshal.WriteInt32(parms, 4, pid);
            Marshal.WriteInt32(parms, 8, 0);
            // PROPVARIANT { vt = VT_BLOB (65), blob = { cbSize = 12, pBlobData = parms } }
            IntPtr pv = Marshal.AllocHGlobal(24);
            for (int i = 0; i < 24; i += 4) Marshal.WriteInt32(pv, i, 0);
            Marshal.WriteInt16(pv, 0, 65);
            Marshal.WriteInt32(pv, 8, 12);
            Marshal.WriteIntPtr(pv, 16, parms);
            IntPtr fmt = Marshal.AllocHGlobal(18);
            IntPtr evt = IntPtr.Zero;
            IAudioClient client = null;
            IAudioCaptureClient capture = null;
            try
            {
                var handler = new ActivationHandler();
                IActivateAudioInterfaceAsyncOperation op;
                ActivateAudioInterfaceAsync("VAD\\Process_Loopback", typeof(IAudioClient).GUID, pv, handler, out op);
                if (!handler.Done.WaitOne(5000)) throw new Exception("Game audio activation timed out");
                if (handler.Hr != 0 || handler.Iface == null) throw new Exception("Game audio activation failed 0x" + handler.Hr.ToString("X8"));
                client = (IAudioClient)handler.Iface;

                // WAVEFORMATEX: IEEE float, stereo, 48 kHz (the engine converts for us)
                Marshal.WriteInt16(fmt, 0, 3);
                Marshal.WriteInt16(fmt, 2, channels);
                Marshal.WriteInt32(fmt, 4, rate);
                Marshal.WriteInt32(fmt, 8, rate * blockAlign);
                Marshal.WriteInt16(fmt, 12, blockAlign);
                Marshal.WriteInt16(fmt, 14, bits);
                Marshal.WriteInt16(fmt, 16, 0);
                const int flags = 0x00020000 /*LOOPBACK*/ | 0x00040000 /*EVENTCALLBACK*/ | unchecked((int)0x80000000) /*AUTOCONVERTPCM*/ | 0x08000000 /*SRC_DEFAULT_QUALITY*/;
                int hr = client.Initialize(0, flags, 2000000, 0, fmt, IntPtr.Zero);
                if (hr != 0) throw new Exception("Game audio Initialize failed 0x" + hr.ToString("X8"));
                var ev = new AutoResetEvent(false);
                client.SetEventHandle(ev.SafeWaitHandle.DangerousGetHandle());
                Guid iidCapture = typeof(IAudioCaptureClient).GUID;
                object o;
                client.GetService(ref iidCapture, out o);
                capture = (IAudioCaptureClient)o;
                onFormat(rate);
                Pump(client, capture, channels, bits, blockAlign, true, ev, sink);
                GC.KeepAlive(ev);
            }
            finally
            {
                if (capture != null) Marshal.ReleaseComObject(capture);
                if (client != null) Marshal.ReleaseComObject(client);
                Marshal.FreeHGlobal(fmt);
                Marshal.FreeHGlobal(pv);
                Marshal.FreeHGlobal(parms);
            }
        }

        // Shared capture loop: downmix to mono float32 and hand to sink until it returns false.
        static void Pump(IAudioClient client, IAudioCaptureClient capture, int channels, int bits, int blockAlign,
                         bool isFloat, WaitHandle ev, Func<byte[], int, bool> sink)
        {
            int hr;
            client.Start();
            byte[] outBuf = new byte[0];
            byte[] raw = new byte[0];
            try
            {
                while (true)
                {
                    int packet;
                    hr = capture.GetNextPacketSize(out packet);
                    if (hr != 0) throw new Exception("Device lost 0x" + hr.ToString("X8"));
                    if (packet == 0)
                    {
                        // Keep the connection alive while silent (and detect closed clients).
                        if (ev != null) ev.WaitOne(20); else Thread.Sleep(8);
                        if (!sink(outBuf, 0)) return;
                        continue;
                    }
                    while (packet > 0)
                    {
                        IntPtr data; int frames, flags; long p1, p2;
                        hr = capture.GetBuffer(out data, out frames, out flags, out p1, out p2);
                        if (hr != 0) throw new Exception("GetBuffer failed 0x" + hr.ToString("X8"));
                        int need = frames * 4;
                        if (outBuf.Length < need) outBuf = new byte[need];
                        bool silent = (flags & 0x2) != 0;
                        if (silent)
                        {
                            Array.Clear(outBuf, 0, need);
                        }
                        else
                        {
                            int rawLen = frames * blockAlign;
                            if (raw.Length < rawLen) raw = new byte[rawLen];
                            Marshal.Copy(data, raw, 0, rawLen);
                            int bytesPer = bits / 8;
                            for (int f = 0; f < frames; f++)
                            {
                                double sum = 0;
                                int baseIdx = f * blockAlign;
                                for (int c = 0; c < channels; c++)
                                {
                                    int idx = baseIdx + c * bytesPer;
                                    double s;
                                    if (isFloat) s = BitConverter.ToSingle(raw, idx);
                                    else if (bits == 16) s = BitConverter.ToInt16(raw, idx) / 32768.0;
                                    else if (bits == 24) s = ((raw[idx] << 8 | raw[idx + 1] << 16 | raw[idx + 2] << 24) >> 8) / 8388608.0;
                                    else s = BitConverter.ToInt32(raw, idx) / 2147483648.0;
                                    sum += s;
                                }
                                float m = (float)(sum / channels);
                                byte[] b = BitConverter.GetBytes(m);
                                Buffer.BlockCopy(b, 0, outBuf, f * 4, 4);
                            }
                        }
                        capture.ReleaseBuffer(frames);
                        if (!sink(outBuf, need)) return;
                        capture.GetNextPacketSize(out packet);
                    }
                }
            }
            finally
            {
                try { client.Stop(); } catch { }
            }
        }
    }

    // ------------------------------------------------------------------ Tiny HTTP server
    class Server
    {
        public const int Port = 5173;
        readonly string root;
        TcpListener listener;

        static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            {".html","text/html; charset=utf-8"}, {".js","application/javascript; charset=utf-8"},
            {".css","text/css; charset=utf-8"}, {".json","application/json; charset=utf-8"},
            {".png","image/png"}, {".jpg","image/jpeg"}, {".svg","image/svg+xml"},
            {".ico","image/x-icon"}, {".wav","audio/wav"}, {".mp3","audio/mpeg"}, {".ogg","audio/ogg"}
        };

        public Server(string root) { this.root = Path.GetFullPath(root); }

        // --dev: serve the web files from disk (next to the exe) instead of the built-in copies
        public static bool DevMode;
        // unique per compile: lets a newer build replace an older running one
        public static DateTime LastPageSeen = DateTime.MinValue;
        public static readonly string BuildId =System.Reflection.Assembly.GetExecutingAssembly().ManifestModule.ModuleVersionId.ToString("N");

        // Web files compiled in with csc /resource:file,web/file
        static byte[] Embedded(string relPath)
        {
            using (var s = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("web/" + relPath))
            {
                if (s == null) return null;
                var ms = new MemoryStream();
                s.CopyTo(ms);
                return ms.ToArray();
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetHandleInformation(IntPtr hObject, int dwMask, int dwFlags);

        public void Start()
        {
            listener = new TcpListener(IPAddress.Loopback, Port);
            listener.Start();
            // Never let child processes (the browser) inherit the listening socket, or the port
            // stays blocked after this app exits.
            SetHandleInformation(listener.Server.Handle, 1 /*HANDLE_FLAG_INHERIT*/, 0);
            var t = new Thread(() =>
            {
                while (true)
                {
                    TcpClient c;
                    try { c = listener.AcceptTcpClient(); } catch { return; }
                    var th = new Thread(() => Handle(c)) { IsBackground = true };
                    th.SetApartmentState(ApartmentState.MTA);
                    th.Start();
                }
            }) { IsBackground = true };
            t.Start();
        }

        static string JsonEsc(string s)
        {
            var sb = new StringBuilder();
            foreach (char ch in s ?? "")
            {
                if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
                else if (ch < 0x20) sb.AppendFormat("\\u{0:x4}", (int)ch);
                else sb.Append(ch);
            }
            return sb.ToString();
        }

        // Real in-game item sounds (as published on abibuilder.com), fetched once and cached locally.
        static readonly string SoundCache = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"ABIFieldMerchant\sounds");
        static readonly System.Text.RegularExpressions.Regex SoundName =
            new System.Text.RegularExpressions.Regex(@"^[A-Za-z0-9_]{1,80}\.ogg$");

        static void ServeRefSound(NetworkStream ns, string name)
        {
            if (!SoundName.IsMatch(name))
            {
                WriteText(ns, 400, "Bad Request", "text/plain", Encoding.ASCII.GetBytes("bad name"));
                return;
            }
            ServeCached(ns, name, SoundCache, "https://abibuilder.com/audio/merchant/" + name, "OggS", "audio/ogg");
        }

        // Extra references: in-game recordings published in neverh8me/abi-merchant-helper (pinned commit, so
        // the files can't change under us). Used where they differ from the abibuilder files.
        const string ExtraBase = "https://raw.githubusercontent.com/neverh8me/abi-merchant-helper/a54df8758ede4cafe29c00d4fe2177a6307ee2af/library/sounds/";
        static readonly System.Text.RegularExpressions.Regex ExtraName =
            new System.Text.RegularExpressions.Regex(@"^[a-z0-9_]{1,80}\.wav$");

        static void ServeExtraSound(NetworkStream ns, string name)
        {
            if (!ExtraName.IsMatch(name))
            {
                WriteText(ns, 400, "Bad Request", "text/plain", Encoding.ASCII.GetBytes("bad name"));
                return;
            }
            ServeCached(ns, name, Path.Combine(SoundCache, "extra"), ExtraBase + name, "RIFF", "audio/wav");
        }

        // abibuilder.com/merchant page (the game data: items, sounds, crate pools) for automatic data updates.
        // Cached for 6 h; when offline the last copy is served; X-Fetched tells the page how old it is.
        static readonly object merchantGate = new object();
        static void ServeMerchantPage(NetworkStream ns)
        {
            string file = Path.Combine(Path.GetDirectoryName(SoundCache), "merchant.html");
            lock (merchantGate)
            {
                bool fresh = File.Exists(file) && (DateTime.UtcNow - File.GetLastWriteTimeUtc(file)).TotalHours < 6;
                if (!fresh)
                {
                    try
                    {
                        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
                        var req = (HttpWebRequest)WebRequest.Create("https://abibuilder.com/merchant");
                        req.UserAgent = "Mozilla/5.0 (ABI Field Merchant Companion)";
                        req.Timeout = 12000;
                        using (var resp = req.GetResponse())
                        using (var r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                        {
                            string html = r.ReadToEnd();
                            if (html.Length > 50000 && html.Contains("soundId"))
                            {
                                Directory.CreateDirectory(Path.GetDirectoryName(file));
                                File.WriteAllText(file + ".tmp", html, Encoding.UTF8);
                                if (File.Exists(file)) File.Delete(file);
                                File.Move(file + ".tmp", file);
                            }
                        }
                    }
                    catch (Exception ex) { Log.Write("merchant data fetch failed: " + ex.Message); }
                }
                if (!File.Exists(file))
                {
                    WriteText(ns, 502, "Bad Gateway", "text/plain", Encoding.ASCII.GetBytes("no merchant data"));
                    return;
                }
                byte[] body = File.ReadAllBytes(file);
                string head = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " + body.Length +
                              "\r\nX-Fetched: " + File.GetLastWriteTimeUtc(file).ToString("yyyy-MM-ddTHH:mm:ssZ") +
                              "\r\nAccess-Control-Expose-Headers: X-Fetched\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                byte[] h = Encoding.ASCII.GetBytes(head);
                ns.Write(h, 0, h.Length); ns.Write(body, 0, body.Length);
            }
        }

        // Download once into the cache folder (checking the file's magic bytes), then serve from disk
        static void ServeCached(NetworkStream ns, string name, string dir, string url, string magic, string mime)
        {
            string file = Path.Combine(dir, name);
            if (!File.Exists(file))
            {
                try
                {
                    Directory.CreateDirectory(dir);
                    ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2
                    var req = (HttpWebRequest)WebRequest.Create(url);
                    req.UserAgent = "Mozilla/5.0 (ABI Field Merchant Companion)";
                    req.Timeout = 15000;
                    byte[] bytes;
                    using (var resp = req.GetResponse())
                    using (var ms = new MemoryStream())
                    {
                        resp.GetResponseStream().CopyTo(ms);
                        bytes = ms.ToArray();
                    }
                    if (bytes.Length < 4 || Encoding.GetEncoding(28591).GetString(bytes, 0, 4) != magic) throw new Exception("unexpected file type"); // Latin-1: byte-exact
                    string tmp = file + ".tmp";
                    File.WriteAllBytes(tmp, bytes);
                    if (File.Exists(file)) File.Delete(tmp); else File.Move(tmp, file);
                }
                catch (Exception ex)
                {
                    WriteText(ns, 502, "Bad Gateway", "text/plain", Encoding.UTF8.GetBytes("Could not fetch " + name + ": " + ex.Message));
                    return;
                }
            }
            WriteText(ns, 200, "OK", mime, File.ReadAllBytes(file));
        }

        static Dictionary<string, string> ParseQuery(string q)
        {
            var d = new Dictionary<string, string>();
            foreach (var part in q.Split('&'))
            {
                if (part.Length == 0) continue;
                int eq = part.IndexOf('=');
                string k = Uri.UnescapeDataString((eq < 0 ? part : part.Substring(0, eq)).Replace('+', ' '));
                string v = eq < 0 ? "" : Uri.UnescapeDataString(part.Substring(eq + 1).Replace('+', ' '));
                d[k] = v;
            }
            return d;
        }

        static void WriteText(NetworkStream ns, int code, string status, string type, byte[] body)
        {
            string head = "HTTP/1.1 " + code + " " + status + "\r\nContent-Type: " + type +
                          "\r\nContent-Length: " + body.Length + "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
            byte[] h = Encoding.ASCII.GetBytes(head);
            ns.Write(h, 0, h.Length);
            ns.Write(body, 0, body.Length);
        }

        static readonly string[] TrustedHosts = { "127.0.0.1:" + Port, "localhost:" + Port };

        static bool IsTrustedRequest(string head)
        {
            string host = null, origin = null, fetchSite = null;
            foreach (var raw in head.Split(new[] { "\r\n" }, StringSplitOptions.None))
            {
                int colon = raw.IndexOf(':');
                if (colon <= 0) continue;
                string name = raw.Substring(0, colon).Trim().ToLowerInvariant(), value = raw.Substring(colon + 1).Trim();
                if (name == "host") host = value.ToLowerInvariant();
                else if (name == "origin") origin = value.ToLowerInvariant();
                else if (name == "sec-fetch-site") fetchSite = value.ToLowerInvariant();
            }
            // DNS rebinding: a foreign site's name resolved to 127.0.0.1 still sends its own Host
            if (host != null && Array.IndexOf(TrustedHosts, host) < 0) return false;
            // A page from another origin (fetch, form, img/script/audio tag, ...)
            if (origin != null && Array.IndexOf(TrustedHosts, origin.Replace("http://", "")) < 0) return false;
            if (fetchSite != null && fetchSite != "same-origin" && fetchSite != "none") return false;
            return true;
        }

        void Handle(TcpClient c)
        {
            using (c)
            {
                try
                {
                    c.NoDelay = true;
                    var ns = c.GetStream();
                    // Read request head
                    var sb = new StringBuilder();
                    var buf = new byte[4096];
                    while (sb.ToString().IndexOf("\r\n\r\n", StringComparison.Ordinal) < 0)
                    {
                        int n = ns.Read(buf, 0, buf.Length);
                        if (n <= 0) return;
                        sb.Append(Encoding.ASCII.GetString(buf, 0, n));
                        if (sb.Length > 65536) return;
                    }
                    string line = sb.ToString().Split(new[] { "\r\n" }, StringSplitOptions.None)[0];
                    string[] parts = line.Split(' ');
                    if (parts.Length < 2) return;
                    string target = parts[1];
                    string path = target, query = "";
                    int qi = target.IndexOf('?');
                    if (qi >= 0) { path = target.Substring(0, qi); query = target.Substring(qi + 1); }
                    path = Uri.UnescapeDataString(path);

                    // Only the app's own pages may use this server. Blocks other websites open in the browser
                    // (cross-site requests, and DNS rebinding via a foreign Host name). Non-browser local tools
                    // (build script, second instance) send no Origin/Sec-Fetch-Site and a loopback Host, so they pass.
                    if (!IsTrustedRequest(sb.ToString()))
                    {
                        WriteText(ns, 403, "Forbidden", "text/plain", Encoding.ASCII.GetBytes("forbidden"));
                        return;
                    }

                    if (path == "/api/ping")
                    {
                        WriteText(ns, 200, "OK", "application/json", Encoding.UTF8.GetBytes("{\"app\":\"abi-companion\",\"native\":true,\"build\":\"" + BuildId + "\"}"));
                        return;
                    }
                    if (path == "/api/quit")
                    {
                        // a newer build is taking over: answer, then exit
                        WriteText(ns, 200, "OK", "text/plain", Encoding.ASCII.GetBytes("bye"));
                        new Thread(() => { Thread.Sleep(150); Environment.Exit(0); }) { IsBackground = true }.Start();
                        return;
                    }
                    if (path == "/api/devices")
                    {
                        List<AudioDeviceInfo> devs;
                        try { devs = Wasapi.ListRenderDevices(); }
                        catch (Exception ex)
                        {
                            WriteText(ns, 500, "Error", "text/plain", Encoding.UTF8.GetBytes(ex.ToString()));
                            return;
                        }
                        var json = new StringBuilder("[");
                        bool first = true;
                        foreach (var d in devs)
                        {
                            if (!first) json.Append(',');
                            first = false;
                            json.Append("{\"id\":\"").Append(JsonEsc(d.Id)).Append("\",\"name\":\"").Append(JsonEsc(d.Name))
                                .Append("\",\"isDefault\":").Append(d.IsDefault ? "true" : "false").Append('}');
                        }
                        json.Append(']');
                        WriteText(ns, 200, "OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes(json.ToString()));
                        return;
                    }
                    if (path == "/api/game")
                    {
                        int pid = Wasapi.FindGamePid();
                        WriteText(ns, 200, "OK", "application/json",
                            Encoding.UTF8.GetBytes("{\"running\":" + (pid > 0 ? "true" : "false") + ",\"pid\":" + pid + "}"));
                        return;
                    }
                    if (path == "/api/mini")
                    {
                        Program.OpenMiniWindow();
                        WriteText(ns, 200, "OK", "text/plain", Encoding.ASCII.GetBytes("ok"));
                        return;
                    }
                    if (path == "/api/autostart")
                    {
                        var q = ParseQuery(query);
                        string v;
                        if (q.TryGetValue("set", out v)) { try { AutoStart.Set(v == "1"); } catch { } }
                        WriteText(ns, 200, "OK", "application/json", Encoding.ASCII.GetBytes("{\"on\":" + (AutoStart.Get() ? "true" : "false") + "}"));
                        return;
                    }
                    if (path == "/api/log")
                    {
                        // one line from the app about a detection (for tuning on real game audio); text only, capped
                        var q = ParseQuery(query);
                        string m;
                        if (q.TryGetValue("m", out m) && m != null)
                        {
                            m = m.Replace('\r', ' ').Replace('\n', ' ');
                            if (m.Length > 400) m = m.Substring(0, 400);
                            Log.Write("heard: " + m);
                        }
                        WriteText(ns, 200, "OK", "text/plain", Encoding.ASCII.GetBytes("ok"));
                        return;
                    }
                    if (path == "/api/selfcheck")
                    {
                        WriteText(ns, 200, "OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes(SelfCheck.Run()));
                        return;
                    }
                    if (path == "/api/state")
                    {
                        LastPageSeen = DateTime.UtcNow; // an app window is open and polling
                        WriteText(ns, 200, "OK", "application/json", Encoding.UTF8.GetBytes(Screen.StateJson()));
                        return;
                    }
                    if (path == "/api/ocr")
                    {
                        // ?x=&y=&w=&h= in game-window client pixels (&scale= enlargement, default 2)
                        // dev only: &file=<png> reads a local image instead of the game window
                        var q = ParseQuery(query);
                        Func<string, double, double> num = (k, d) => { string v; double r; return q.TryGetValue(k, out v) && double.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out r) ? r : d; };
                        try
                        {
                            Bitmap bmp;
                            string file;
                            // relative paths (e.g. tools/_test/x.png) resolve against the exe's folder
                            if (DevMode && q.TryGetValue("file", out file)) bmp = new Bitmap(System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, file));
                            else bmp = Screen.GrabClient((int)num("x", 0), (int)num("y", 0), (int)num("w", 400), (int)num("h", 100));
                            if (bmp == null) { WriteText(ns, 409, "No Game Window", "text/plain", Encoding.ASCII.GetBytes("game window not found")); return; }
                            using (bmp) WriteText(ns, 200, "OK", "application/json; charset=utf-8", Encoding.UTF8.GetBytes(TextReader.Read(bmp, num("scale", 2))));
                        }
                        catch (Exception ex)
                        {
                            WriteText(ns, 500, "Error", "text/plain", Encoding.UTF8.GetBytes((ex.InnerException ?? ex).Message));
                        }
                        return;
                    }
                    if (path == "/api/frame" || path == "/api/snapshot")
                    {
                        var q = ParseQuery(query);
                        Func<string, double, double> num = (k, d) => { string v; double r; return q.TryGetValue(k, out v) && double.TryParse(v, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out r) ? r : d; };
                        bool snap = path == "/api/snapshot";
                        string meta;
                        byte[] img = Screen.Capture(num("x", 0), num("y", 0), num("w", 1), num("h", 1), num("scale", 1), snap || q.ContainsKey("png"), out meta);
                        if (img == null) { WriteText(ns, 409, "No Game Window", "text/plain", Encoding.ASCII.GetBytes("game window not found")); return; }
                        if (snap)
                        {
                            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"ABIFieldMerchant\snapshots");
                            Directory.CreateDirectory(dir);
                            string file = Path.Combine(dir, "snap-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".png");
                            File.WriteAllBytes(file, img);
                            WriteText(ns, 200, "OK", "text/plain", Encoding.UTF8.GetBytes(file + "\n" + meta));
                            return;
                        }
                        string head = "HTTP/1.1 200 OK\r\nContent-Type: " + (q.ContainsKey("png") ? "image/png" : "image/jpeg") +
                                      "\r\nContent-Length: " + img.Length + "\r\nX-Frame: " + meta +
                                      "\r\nAccess-Control-Expose-Headers: X-Frame\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                        byte[] hb = Encoding.ASCII.GetBytes(head);
                        ns.Write(hb, 0, hb.Length); ns.Write(img, 0, img.Length);
                        return;
                    }
                    if (path.StartsWith("/api/refsound/"))
                    {
                        ServeRefSound(ns, path.Substring("/api/refsound/".Length));
                        return;
                    }
                    if (path.StartsWith("/api/icon/"))
                    {
                        string name = path.Substring("/api/icon/".Length);
                        if (!System.Text.RegularExpressions.Regex.IsMatch(name, @"^\d{6,12}\.png$"))
                        {
                            WriteText(ns, 400, "Bad Request", "text/plain", Encoding.ASCII.GetBytes("bad name"));
                            return;
                        }
                        ServeCached(ns, name, Path.Combine(Path.GetDirectoryName(SoundCache), "icons"),
                            "https://hexaov91.github.io/abi-assets/image/Normal/" + name, "\u0089PNG", "image/png");
                        return;
                    }
                    if (path == "/api/merchantpage")
                    {
                        ServeMerchantPage(ns);
                        return;
                    }
                    if (path.StartsWith("/api/extrasound/"))
                    {
                        ServeExtraSound(ns, path.Substring("/api/extrasound/".Length));
                        return;
                    }
                    if (path == "/api/loopback")
                    {
                        var q = ParseQuery(query);
                        string devId; q.TryGetValue("device", out devId);
                        string source; q.TryGetValue("source", out source);
                        int gamePid = 0;
                        if (source == "game")
                        {
                            gamePid = Wasapi.FindGamePid();
                            if (gamePid == 0)
                            {
                                WriteText(ns, 409, "Game Not Running", "text/plain", Encoding.UTF8.GetBytes("Arena Breakout: Infinite is not running"));
                                return;
                            }
                        }
                        bool headerSent = false;
                        try
                        {
                            Action<int> onFormat =
                                rate =>
                                {
                                    string head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nX-Sample-Rate: " + rate +
                                                  "\r\nAccess-Control-Expose-Headers: X-Sample-Rate\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                                    byte[] h = Encoding.ASCII.GetBytes(head);
                                    ns.Write(h, 0, h.Length);
                                    headerSent = true;
                                };
                            Func<byte[], int, bool> sink =
                                (data, len) =>
                                {
                                    try
                                    {
                                        if (len > 0) ns.Write(data, 0, len);
                                        else if (c.Client.Poll(0, SelectMode.SelectRead) && c.Client.Available == 0) return false; // closed
                                        return true;
                                    }
                                    catch { return false; }
                                };
                            if (gamePid > 0) Wasapi.CaptureProcess(gamePid, onFormat, sink);
                            else Wasapi.CaptureLoopback(devId, onFormat, sink);
                        }
                        catch (Exception ex)
                        {
                            if (!headerSent) WriteText(ns, 500, "Error", "text/plain", Encoding.UTF8.GetBytes(ex.Message));
                        }
                        return;
                    }

                    // Static files: built into the exe (single-file app); disk only for extras like tools/eval.html
                    if (path == "/" || path == "") path = "/index.html";
                    byte[] embedded = DevMode ? null : Embedded(path.TrimStart('/'));
                    if (embedded != null)
                    {
                        string etype;
                        if (!Mime.TryGetValue(Path.GetExtension(path), out etype)) etype = "application/octet-stream";
                        WriteText(ns, 200, "OK", etype, embedded);
                        return;
                    }
                    string full = Path.GetFullPath(Path.Combine(root, path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
                    if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
                    {
                        WriteText(ns, 404, "Not Found", "text/plain", Encoding.ASCII.GetBytes("404 Not Found"));
                        return;
                    }
                    string type;
                    if (!Mime.TryGetValue(Path.GetExtension(full), out type)) type = "application/octet-stream";
                    WriteText(ns, 200, "OK", type, File.ReadAllBytes(full));
                }
                catch { }
            }
        }
    }

    // ------------------------------------------------------------------ The app's own windows (Chrome --app)
    static class AppWindows
    {
        delegate bool EnumProc(IntPtr h, IntPtr p);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);

        // top-level browser windows whose title starts with `title` (our pages set their titles)
        public static List<IntPtr> Find(string title, bool includeHidden = false)
        {
            var list = new List<IntPtr>();
            EnumWindows((h, p) =>
            {
                var t = new StringBuilder(256); GetWindowText(h, t, 256);
                var c = new StringBuilder(64); GetClassName(h, c, 64);
                if (c.ToString() == "Chrome_WidgetWin_1" && t.ToString().StartsWith(title) && (includeHidden || IsWindowVisible(h))) list.Add(h);
                return true;
            }, IntPtr.Zero);
            return list;
        }
        public static void TopMost(IntPtr h) { SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); }
        // bring back the main window if it exists (hidden or not); false when there is none
        public static bool ToggleMainShow()
        {
            var all = Find("ABI Field Merchant", true);
            foreach (var h in all) { ShowWindow(h, 5); ShowWindow(h, 9); SetForegroundWindow(h); }
            return all.Count > 0;
        }
        // hide the main window to the tray (it keeps listening) / show it again
        public static bool ToggleMain()
        {
            var shown = Find("ABI Field Merchant");
            if (shown.Count > 0) { foreach (var h in shown) ShowWindow(h, 0); return false; }
            var hidden = Find("ABI Field Merchant", true);
            foreach (var h in hidden) { ShowWindow(h, 5); SetForegroundWindow(h); }
            return hidden.Count > 0;
        }
    }

    // ------------------------------------------------------------------ Start with Windows (HKCU Run key)
    static class AutoStart
    {
        const string Key = @"Software\Microsoft\Windows\CurrentVersion\Run", Name = "ABI Field Merchant";
        public static bool Get()
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(Key)) return k != null && k.GetValue(Name) != null;
        }
        public static void Set(bool on)
        {
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(Key, true))
            {
                if (k == null) return;
                if (on) k.SetValue(Name, "\"" + Application.ExecutablePath + "\"");
                else if (k.GetValue(Name) != null) k.DeleteValue(Name);
            }
        }
    }

    // ------------------------------------------------------------------ Self-check (for "it doesn't work" moments)
    static class SelfCheck
    {
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
        [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
        [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public Screen.RECT rcMonitor, rcWork; public int dwFlags; }
        [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);

        static string J(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }
        static string Item(string id, string status, string text) { return "{\"id\":\"" + id + "\",\"status\":\"" + status + "\",\"text\":\"" + J(text) + "\"}"; }

        public static string Run()
        {
            var items = new List<string>();
            // Windows build: game-only audio needs 20348+
            int build = 0;
            try { build = int.Parse((string)Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber", "0")); } catch { }
            items.Add(build >= 20348
                ? Item("windows", "ok", "Windows build " + build + ": game-only audio supported.")
                : Item("windows", "warn", "Windows build " + build + " is too old for game-only audio (needs Windows 11). Open Settings and choose your headset/speakers under 'Listen to'."));
            // Game + window
            int pid = Wasapi.FindGamePid();
            if (pid == 0) items.Add(Item("game", "info", "Arena Breakout isn't running. Start it and the app connects by itself."));
            else
            {
                IntPtr h = Screen.GameWindow();
                var area = Screen.ClientArea(h);
                if (area == null) items.Add(Item("game", "warn", "The game is running but its window isn't visible (minimised?). Screen reading needs the game window on screen."));
                else
                {
                    var a = area.Value;
                    int style = GetWindowLong(h, -16);
                    bool caption = (style & 0x00C00000) == 0x00C00000;
                    var mi = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
                    GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
                    bool fillsMonitor = a.Width >= (mi.rcMonitor.R - mi.rcMonitor.L) - 2 && a.Height >= (mi.rcMonitor.B - mi.rcMonitor.T) - 2;
                    string size = a.Width + "x" + a.Height;
                    if (caption) items.Add(Item("game", "warn", "The game runs in a normal window (" + size + "). It works, but Borderless Window gives the most reliable screen reading."));
                    else items.Add(Item("game", "ok", "Game window found (" + size + (fillsMonitor ? ", full screen" : "") + "). If screen reading shows nothing, make sure the game uses Borderless Window, not Fullscreen."));
                    // a quick look: an exclusive-fullscreen game shows up as black in screen copies
                    try
                    {
                        using (var bmp = Screen.GrabClient(a.Width / 4, a.Height / 4, a.Width / 2, a.Height / 2))
                        {
                            long sum = 0; int n = 0;
                            for (int y = 0; y < bmp.Height; y += bmp.Height / 12 + 1)
                                for (int x = 0; x < bmp.Width; x += bmp.Width / 12 + 1) { var c = bmp.GetPixel(x, y); sum += c.R + c.G + c.B; n++; }
                            if (n > 0 && sum / n < 6) items.Add(Item("capture", "warn", "The game picture looks completely black. Exclusive Fullscreen can't be captured: switch the game to Borderless Window."));
                            else items.Add(Item("capture", "ok", "The game picture can be captured."));
                        }
                    }
                    catch { items.Add(Item("capture", "warn", "Couldn't take a picture of the game window.")); }
                }
            }
            // Text reading
            items.Add(TextReader.Available()
                ? Item("ocr", "ok", "Windows text reading (OCR) is available.")
                : Item("ocr", "warn", "Windows text reading isn't available. Install the English language pack (Settings > Time & language > Language) - needed to read crate names and prices."));
            // F8
            items.Add(HotkeyWindow.Mode == "hotkey" ? Item("f8", "ok", "F8 screenshots ready.")
                : HotkeyWindow.Mode == "polling" ? Item("f8", "ok", "F8 screenshots ready (another program holds F8, so the app watches the key instead).")
                : Item("f8", "info", "F8 screenshots aren't set up yet."));
            // Caches
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ABIFieldMerchant");
            int sounds = Directory.Exists(Path.Combine(dir, "sounds")) ? Directory.GetFiles(Path.Combine(dir, "sounds"), "*.ogg").Length : 0;
            items.Add(sounds >= 70 ? Item("sounds", "ok", sounds + " game sounds downloaded.")
                : Item("sounds", "warn", "Only " + sounds + " of 76 game sounds are downloaded. The app needs internet once to fetch them."));
            return "{\"items\":[" + string.Join(",", items.ToArray()) + "],\"build\":\"" + Server.BuildId + "\"}";
        }
    }

    // ------------------------------------------------------------------ Global hotkey: F8 snapshot
    class HotkeyWindow : NativeWindow
    {
        [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
        const int WM_HOTKEY = 0x0312;
        // Kept in a static field: otherwise the optimised build lets the GC collect this window, which
        // silently unregisters the hotkey (that was the "F8 does nothing" bug).
        public static HotkeyWindow Instance;
        public static string Mode = "not started"; // "hotkey" | "polling" | "not started"
        static long lastShot;

        public HotkeyWindow()
        {
            CreateHandle(new CreateParams());
            bool ok = RegisterHotKey(Handle, 1, 0x4000 /*MOD_NOREPEAT*/, 0x77 /*F8*/);
            Mode = ok ? "hotkey" : "polling";
            Log.Write("F8 hotkey " + (ok ? "registered" : "registration failed, error " + Marshal.GetLastWin32Error() + " - using key polling"));
            if (!ok)
            {
                // fallback: watch the key directly
                new Thread(() =>
                {
                    bool was = false;
                    while (true)
                    {
                        bool down = (GetAsyncKeyState(0x77) & 0x8000) != 0;
                        if (down && !was) Shoot();
                        was = down;
                        Thread.Sleep(30);
                    }
                }) { IsBackground = true }.Start();
            }
        }
        static void Shoot()
        {
            long now = DateTime.UtcNow.Ticks;
            if (now - Interlocked.Read(ref lastShot) < TimeSpan.TicksPerSecond / 2) return;
            Interlocked.Exchange(ref lastShot, now);
            // a 4K PNG takes a moment: never block the message loop
            new Thread(() => { string f = Snapshot.Save(true); Log.Write("F8 snapshot: " + (f ?? "FAILED (game window not found)")); }) { IsBackground = true }.Start();
        }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY) Shoot();
            base.WndProc(ref m);
        }
    }

    // Small diagnostic log: %LOCALAPPDATA%\ABIFieldMerchant\app.log (kept under ~200 KB)
    static class Log
    {
        static readonly object gate = new object();
        public static void Write(string msg)
        {
            try
            {
                lock (gate)
                {
                    string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ABIFieldMerchant");
                    Directory.CreateDirectory(dir);
                    string f = Path.Combine(dir, "app.log");
                    if (File.Exists(f) && new FileInfo(f).Length > 200000) File.Delete(f);
                    File.AppendAllText(f, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "  " + msg + Environment.NewLine);
                }
            }
            catch { }
        }
    }

    static class Snapshot
    {
        public static string Dir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"ABIFieldMerchant\snapshots"); }
        }
        // Full game-window PNG + a .json with the window/cursor state at that moment
        public static string Save(bool beep)
        {
            try
            {
                string state = Screen.StateJson();
                string meta;
                byte[] png = Screen.Capture(0, 0, 1, 1, 1, true, out meta);
                if (png == null) { if (beep) System.Media.SystemSounds.Hand.Play(); return null; }
                Directory.CreateDirectory(Dir);
                string file = Path.Combine(Dir, "snap-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff"));
                File.WriteAllBytes(file + ".png", png);
                File.WriteAllText(file + ".json", state);
                if (beep) System.Media.SystemSounds.Asterisk.Play();
                return file + ".png";
            }
            catch { return null; }
        }
    }

    // ------------------------------------------------------------------ Entry point
    static class Program
    {
        const string Url = "http://localhost:5173/";

        static bool TookOver;

        static string Get(string path, int timeout)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:5173" + path);
                req.Timeout = timeout;
                using (var resp = req.GetResponse())
                using (var r = new StreamReader(resp.GetResponseStream()))
                    return r.ReadToEnd();
            }
            catch { return null; }
        }

        // true: the same build is already running. A different (older or newer) build is asked to exit
        // so this one takes over; builds from before /api/quit existed are ended directly.
        static bool SameBuildRunning()
        {
            string ping = Get("/api/ping", 800);
            if (ping == null || !ping.Contains("abi-companion")) return false;
            if (ping.Contains(Server.BuildId)) return true;
            TookOver = true;
            Get("/api/quit", 800);
            for (int i = 0; i < 20 && Get("/api/ping", 300) != null; i++) Thread.Sleep(150);
            if (Get("/api/ping", 300) != null)
            {
                int me = Process.GetCurrentProcess().Id;
                foreach (var name in new[] { "ABI-Field-Merchant", "Launch-ABI-Companion" })
                    foreach (var p in Process.GetProcessesByName(name))
                        if (p.Id != me) try { p.Kill(); p.WaitForExit(2000); } catch { }
                Thread.Sleep(300);
            }
            return false;
        }

        static void OpenAppWindow(string appDir) { OpenBrowser(appDir, Url, 1340, 920, 40, 40); }

        // The small always-on-top window (mini.html mirrors the main window; it doesn't listen itself)
        public static void OpenMiniWindow()
        {
            var wa = System.Windows.Forms.Screen.PrimaryScreen.WorkingArea;
            OpenBrowser(AppDomain.CurrentDomain.BaseDirectory, Url + "mini.html", 380, 560, wa.Right - 400, wa.Top + 60);
            new Thread(() =>
            {
                for (int i = 0; i < 40; i++)
                {
                    Thread.Sleep(250);
                    var h = AppWindows.Find("ABI Mini");
                    if (h.Count > 0) { foreach (var w in h) AppWindows.TopMost(w); return; }
                }
            }) { IsBackground = true }.Start();
        }

        static void OpenBrowser(string appDir, string url, int w, int h, int x, int y)
        {
            string[] candidates =
            {
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe"),
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe"
            };
            string browser = null;
            foreach (var p in candidates) if (File.Exists(p)) { browser = p; break; }
            if (browser == null) { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); return; }

            // Dedicated profile so the flags below actually apply (they're ignored if attached to an existing Chrome).
            string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"ABIFieldMerchant\browser-profile");
            Directory.CreateDirectory(profile);
            string args = string.Format(
                "--app=\"{0}\" --user-data-dir=\"{1}\" --no-first-run --no-default-browser-check " +
                "--autoplay-policy=no-user-gesture-required --disable-background-timer-throttling " +
                "--disable-renderer-backgrounding --disable-backgrounding-occluded-windows " +
                "--window-size={2},{3} --window-position={4},{5}", url, profile, w, h, x, y);
            // ShellExecute: the browser does not inherit any of our handles (sockets, audio).
            Process.Start(new ProcessStartInfo(browser, args) { WorkingDirectory = appDir, UseShellExecute = true });
        }

        static string DataDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ABIFieldMerchant"); }
        }

        // One-time hint so people know where the app went when its window is closed.
        static void FirstRunTip(NotifyIcon tray)
        {
            try
            {
                string flag = Path.Combine(DataDir, "first-run-done");
                if (File.Exists(flag)) return;
                Directory.CreateDirectory(DataDir);
                File.WriteAllText(flag, DateTime.Now.ToString("o"));
                tray.ShowBalloonTip(8000, "ABI Field Merchant is running",
                    "It lives here in the tray. Right-click this icon to add a Desktop shortcut or to exit.", ToolTipIcon.Info);
            }
            catch { }
        }

        static void CreateDesktopShortcut()
        {
            try
            {
                string lnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "ABI Field Merchant.lnk");
                Type t = Type.GetTypeFromProgID("WScript.Shell");
                dynamic shell = Activator.CreateInstance(t);
                dynamic sc = shell.CreateShortcut(lnk);
                sc.TargetPath = Application.ExecutablePath;
                sc.WorkingDirectory = Path.GetDirectoryName(Application.ExecutablePath);
                sc.IconLocation = Application.ExecutablePath + ",0";
                sc.Description = "ABI Field Merchant - mystery crate sound decoder";
                sc.Save();
                MessageBox.Show("Shortcut added to your Desktop.\n\nTip: keep this .exe where it is - the shortcut points to it.",
                    "ABI Field Merchant", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not create the shortcut: " + ex.Message, "ABI Field Merchant", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        [STAThread]
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        static void Main(string[] cliArgs)
        {
            // real pixel coordinates for screen capture on scaled (125%/150%) displays
            try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
            string appDir = AppDomain.CurrentDomain.BaseDirectory;
            bool noBrowser = Array.IndexOf(cliArgs, "--server-only") >= 0;
            Server.DevMode = Array.IndexOf(cliArgs, "--dev") >= 0;
            try
            {
                if (SameBuildRunning()) { if (!noBrowser && !AppWindows.ToggleMainShow()) OpenAppWindow(appDir); return; }

                var server = new Server(appDir);
                try { server.Start(); }
                catch (SocketException)
                {
                    MessageBox.Show("Port 5173 is already used by another program.\n" +
                                    "Close any open ABI Field Merchant windows (or the program using port 5173) and launch again.", "ABI Field Merchant", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                if (!noBrowser)
                {
                    if (TookOver)
                    {
                        // an app window that was already open reloads onto this build by itself (it checks the
                        // build id); only open a new window if none shows up within a few seconds
                        new Thread(() =>
                        {
                            Thread.Sleep(4500);
                            if ((DateTime.UtcNow - Server.LastPageSeen).TotalSeconds > 4) OpenAppWindow(appDir);
                        }) { IsBackground = true }.Start();
                    }
                    else OpenAppWindow(appDir);
                }

                Application.EnableVisualStyles();
                Icon appIcon;
                try { appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { appIcon = SystemIcons.Application; }
                var menu = new ContextMenuStrip();
                menu.Items.Add("Open ABI Field Merchant", null, (s, e) => { if (!AppWindows.ToggleMainShow()) OpenAppWindow(appDir); });
                menu.Items.Add("Hide / show window (keeps listening)", null, (s, e) => AppWindows.ToggleMain());
                menu.Items.Add("Mini window (always on top)", null, (s, e) => OpenMiniWindow());
                menu.Items.Add(new ToolStripSeparator());
                var auto = new ToolStripMenuItem("Start with Windows") { CheckOnClick = true };
                try { auto.Checked = AutoStart.Get(); } catch { }
                auto.CheckedChanged += (s, e) => { try { AutoStart.Set(auto.Checked); } catch { } };
                menu.Opening += (s, e) => { try { auto.Checked = AutoStart.Get(); } catch { } };
                menu.Items.Add(auto);
                menu.Items.Add("Add Desktop shortcut", null, (s, e) => CreateDesktopShortcut());
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("Exit", null, (s, e) => Application.Exit());
                var tray = new NotifyIcon
                {
                    Icon = appIcon,
                    Text = "ABI Field Merchant (listening to game audio)",
                    ContextMenuStrip = menu,
                    Visible = true
                };
                tray.DoubleClick += (s, e) => { if (!AppWindows.ToggleMainShow()) OpenAppWindow(appDir); };
                FirstRunTip(tray);
                Log.Write("started build " + Server.BuildId + (noBrowser ? " (server only)" : "") + (Server.DevMode ? " (dev)" : ""));
                HotkeyWindow.Instance = new HotkeyWindow(); // F8 = save a game-window snapshot (for tuning screen reading)
                Application.Run();
                tray.Visible = false;
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to start ABI Field Merchant Companion:\n" + ex.Message,
                    "ABI Field Merchant Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher
{
    private const string AppName = "운명원 댓글 스튜디오";
    private const string PayloadName = "AIComment.Payload.zip";
    private const int Port = 5000;
    private static readonly Uri Home = new Uri("http://127.0.0.1:5000/");

    [STAThread]
    private static int Main(string[] args)
    {
        bool selfTest = args.Length == 1 && args[0] == "--self-test";
        try
        {
            if (selfTest) { TestInstallation(); return 0; }

            Application.EnableVisualStyles();
            RunStudio();
            return 0;
        }
        catch (Exception error)
        {
            if (selfTest) Console.Error.WriteLine(error);
            else ShowError(error is InvalidOperationException ? error.Message :
                "댓글 스튜디오를 열지 못했습니다. 파일을 다시 내려받아 실행해 주세요.");
            return 1;
        }
    }

    private static void RunStudio()
    {
        string appFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "UnmyeongwonStudio");
        string runtime = null;
        Process server = null;
        try
        {
            using (var startup = new Mutex(false, @"Local\UnmyeongwonStudio.Startup"))
            {
                if (!AcquireStartup(startup))
                    throw new InvalidOperationException("댓글 스튜디오를 여는 중입니다. 잠시 후 다시 실행해 주세요.");

                try
                {
                    if (CheckPort())
                    {
                        OpenBrowser();
                        return;
                    }

                    runtime = InstallRuntime(appFolder);
                    server = StartServer(runtime, Path.Combine(appFolder, "data"), Port, null, null);
                    if (WaitForStudio(server, delegate { return Home; }) == null)
                    {
                        if (server.HasExited && CheckPort())
                        {
                            OpenBrowser();
                            return;
                        }
                        throw new InvalidOperationException("로컬 서버가 시작되지 않았습니다. 잠시 후 다시 실행해 주세요.");
                    }
                }
                finally { startup.ReleaseMutex(); }
            }

            OpenBrowser();
            RunTray(server, Path.Combine(runtime, "chrome-extension"));
        }
        finally { StopServer(server); }
    }

    private static bool AcquireStartup(Mutex startup)
    {
        try { return startup.WaitOne(TimeSpan.FromSeconds(45)); }
        catch (AbandonedMutexException) { return true; }
    }

    private static bool CheckPort()
    {
        using (var client = new TcpClient(AddressFamily.InterNetwork))
        {
            try
            {
                if (!client.ConnectAsync(IPAddress.Loopback, Port).Wait(1000) || !client.Connected)
                    return false;
            }
            catch (AggregateException error)
            {
                if (!(error.GetBaseException() is SocketException)) throw;
                return false;
            }
        }
        if (IsStudio(Home)) return true;
        throw new InvalidOperationException("다른 프로그램이 로컬 포트 5000을 사용 중입니다. 해당 프로그램을 닫고 다시 실행해 주세요.");
    }

    private static string InstallRuntime(string appFolder)
    {
        string versions = Path.Combine(appFolder, "runtime");
        Directory.CreateDirectory(versions);

        using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadName))
        using (var sha256 = SHA256.Create())
        {
            if (payload == null) throw new InvalidOperationException("실행 파일에서 앱을 찾지 못했습니다. 새 파일을 내려받아 주세요.");
            string version = BitConverter.ToString(sha256.ComputeHash(payload)).Replace("-", "").ToLowerInvariant();
            string install = PathInside(versions, version.Substring(0, 32));
            string marker = Path.Combine(install, ".ready");
            if (File.Exists(marker) && File.ReadAllText(marker) == version && RuntimeComplete(install)) return install;

            string stage = PathInside(versions, ".extract-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(stage);
                payload.Position = 0;
                using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
                {
                    foreach (ZipArchiveEntry entry in zip.Entries)
                    {
                        string relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                        if (relative.IndexOf(':') >= 0) throw new InvalidDataException("Invalid payload entry.");
                        string destination = PathInside(stage, relative);
                        if (string.IsNullOrEmpty(entry.Name)) Directory.CreateDirectory(destination);
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(destination));
                            using (Stream input = entry.Open())
                            using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write))
                                input.CopyTo(output);
                        }
                    }
                }
                if (!RuntimeComplete(stage)) throw new InvalidDataException("Incomplete application payload.");
                File.WriteAllText(Path.Combine(stage, ".ready"), version);
                if (Directory.Exists(install))
                    Directory.Move(install, PathInside(versions, ".incomplete-" + Guid.NewGuid().ToString("N")));
                Directory.Move(stage, install);
                return install;
            }
            finally { RemoveScratch(versions, stage); }
        }
    }

    private static bool RuntimeComplete(string folder)
    {
        return File.Exists(Path.Combine(folder, "node.exe")) &&
            File.Exists(Path.Combine(folder, "server.mjs")) &&
            File.Exists(Path.Combine(folder, "public", "index.html")) &&
            File.Exists(Path.Combine(folder, "chrome-extension", "manifest.json")) &&
            File.Exists(Path.Combine(folder, "node_modules", "playwright", "package.json"));
    }

    private static string PathInside(string directory, string path)
    {
        string root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string destination = Path.GetFullPath(Path.Combine(root, path));
        if (!destination.StartsWith(root, StringComparison.OrdinalIgnoreCase) || destination.Length == root.Length)
            throw new InvalidDataException("Path outside the application directory.");
        return destination;
    }

    private static void RemoveScratch(string root, string folder)
    {
        string path = PathInside(root, folder);
        try { if (Directory.Exists(path)) Directory.Delete(path, true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static Process StartServer(string runtime, string data, int port,
        string isolatedHome, Action<string> onOutput)
    {
        var start = new ProcessStartInfo(Path.Combine(runtime, "node.exe"), "server.mjs")
        {
            WorkingDirectory = runtime,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
        };
        start.EnvironmentVariables["STUDIO_PORT"] = port.ToString(System.Globalization.CultureInfo.InvariantCulture);
        start.EnvironmentVariables["STUDIO_DATA_DIR"] = data;
        start.EnvironmentVariables["STUDIO_MANAGED_LAUNCHER"] = "1";
        start.EnvironmentVariables.Remove("NODE_OPTIONS");
        start.EnvironmentVariables.Remove("NODE_PATH");
        if (isolatedHome != null)
        {
            start.EnvironmentVariables["LOCALAPPDATA"] = isolatedHome;
            start.EnvironmentVariables.Remove("GEMINI_API_KEY");
            start.EnvironmentVariables.Remove("OPENAI_API_KEY");
        }

        var child = new Process { StartInfo = start };
        if (onOutput != null)
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { onOutput(e.Data); };
        try
        {
            child.Start();
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            return child;
        }
        catch
        {
            StopServer(child);
            throw;
        }
    }

    private static Uri WaitForStudio(Process server, Func<Uri> address)
    {
        var elapsed = Stopwatch.StartNew();
        while (!server.HasExited && elapsed.Elapsed < TimeSpan.FromSeconds(20))
        {
            Uri origin = address();
            if (origin != null && IsStudio(origin)) return origin;
            Thread.Sleep(120);
        }
        return null;
    }

    private static bool IsStudio(Uri origin)
    {
        string html = ReadLocalPage(origin);
        return html.Contains("<title>" + AppName + "</title>") &&
            html.Contains("id=\"video-url\"") && html.Contains("id=\"history-list\"");
    }

    private static string ReadLocalPage(Uri uri)
    {
        if (!uri.IsLoopback || uri.Scheme != Uri.UriSchemeHttp) throw new InvalidOperationException("로컬 서버 주소가 올바르지 않습니다.");
        var request = (HttpWebRequest)WebRequest.Create(uri);
        request.Proxy = null;
        request.AllowAutoRedirect = false;
        request.Timeout = 900;
        request.ReadWriteTimeout = 900;
        try
        {
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                var buffer = new char[16 * 1024];
                return response.StatusCode == HttpStatusCode.OK ? new string(buffer, 0, reader.ReadBlock(buffer, 0, buffer.Length)) : "";
            }
        }
        catch (WebException error)
        {
            if (error.Response != null) error.Response.Dispose();
            return "";
        }
        catch (IOException) { return ""; }
    }

    private static void RunTray(Process server, string extensionFolder)
    {
        using (var tray = new NotifyIcon())
        using (var menu = new ContextMenuStrip())
        using (var timer = new System.Windows.Forms.Timer())
        {
            menu.Items.Add("댓글 스튜디오 열기", null, delegate { OpenWithShell(Home.AbsoluteUri); });
            menu.Items.Add("Chrome 확장 폴더 열기", null, delegate { OpenWithShell(extensionFolder); });
            menu.Items.Add("댓글 스튜디오 종료", null, delegate { Application.ExitThread(); });
            tray.Text = AppName;
            tray.Icon = SystemIcons.Application;
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { OpenWithShell(Home.AbsoluteUri); };
            tray.Visible = true;
            timer.Interval = 1500;
            timer.Tick += delegate
            {
                if (!server.HasExited) return;
                timer.Stop();
                ShowError("로컬 서버가 종료되었습니다. 댓글 스튜디오 실행 파일을 다시 열어 주세요.");
                Application.ExitThread();
            };
            timer.Start();
            Application.Run();
            tray.Visible = false;
        }
    }

    private static void OpenBrowser() { OpenWithShell(Home.AbsoluteUri); }

    private static void OpenWithShell(string target)
    {
        try
        {
            using (Process opened = Process.Start(new ProcessStartInfo(target) { UseShellExecute = true })) { }
        }
        catch (System.ComponentModel.Win32Exception)
        {
            ShowError("자동으로 열지 못했습니다. 다음 주소를 직접 열어 주세요.\n\n" + target);
        }
    }

    private static void StopServer(Process server)
    {
        if (server == null) return;
        using (server)
        {
            try
            {
                if (server.HasExited) return;
                try { server.StandardInput.Close(); }
                catch (IOException) { }
                if (server.WaitForExit(3500)) return;
                server.Kill();
                server.WaitForExit(2000);
            }
            catch (InvalidOperationException) { }
        }
    }

    private static void TestInstallation()
    {
        string temp = Path.GetTempPath();
        string sandbox = PathInside(temp, "uws-test-" + Guid.NewGuid().ToString("N"));
        Process server = null;
        try
        {
            string runtime = InstallRuntime(sandbox);
            string data = Path.Combine(sandbox, "data");
            int startedPort = 0;
            server = StartServer(runtime, data, 0, sandbox, delegate(string line)
            {
                const string prefix = "운명원 댓글 작업실 ";
                Uri origin;
                if (line != null && line.StartsWith(prefix, StringComparison.Ordinal) &&
                    Uri.TryCreate(line.Substring(prefix.Length), UriKind.Absolute, out origin) &&
                    origin.IsLoopback && origin.Scheme == Uri.UriSchemeHttp && origin.Port > 0)
                    Interlocked.Exchange(ref startedPort, origin.Port);
            });
            Uri ready = WaitForStudio(server, delegate
            {
                int port = Volatile.Read(ref startedPort);
                return port == 0 ? null : new UriBuilder("http", "127.0.0.1", port).Uri;
            });
            if (ready == null || !ReadLocalPage(new Uri(ready, "api/history")).Contains("\"records\":[]") ||
                !File.Exists(Path.Combine(data, "history.sqlite3")))
                throw new InvalidOperationException("패키지의 로컬 화면, 게시 기록 또는 데이터 파일을 확인하지 못했습니다.");
        }
        finally
        {
            StopServer(server);
            RemoveScratch(temp, sandbox);
        }
    }

    private static void ShowError(string message)
    {
        MessageBox.Show(message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}

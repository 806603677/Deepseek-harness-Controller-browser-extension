using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal sealed class PendingClient
{
    public StreamWriter Writer;
    public DateTime CreatedUtc;
}

internal sealed class PendingFile
{
    public string ResponsePath;
    public DateTime CreatedUtc;
}

internal sealed class DshEdgeNativeHost
{
    private static readonly string PipeName = Environment.GetEnvironmentVariable("DSH_EDGE_PIPE_NAME") ?? "dsh-edge-bridge-v1";
    private readonly Stream nativeInput = Console.OpenStandardInput();
    private readonly Stream nativeOutput = Console.OpenStandardOutput();
    private readonly object nativeWriteLock = new object();
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly ConcurrentDictionary<string, PendingClient> pending = new ConcurrentDictionary<string, PendingClient>();
    private readonly ConcurrentDictionary<string, PendingFile> pendingFiles = new ConcurrentDictionary<string, PendingFile>();
    private readonly string runtimeDirectory;
    private readonly string requestDirectory;
    private readonly string processingDirectory;
    private readonly string responseDirectory;
    private volatile bool stopping;

    private DshEdgeNativeHost()
    {
        string configuredRuntime = Environment.GetEnvironmentVariable("DSH_EDGE_RUNTIME_DIRECTORY");
        runtimeDirectory = String.IsNullOrWhiteSpace(configuredRuntime)
            ? Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "runtime"))
            : Path.GetFullPath(configuredRuntime);
        requestDirectory = Path.Combine(runtimeDirectory, "requests");
        processingDirectory = Path.Combine(runtimeDirectory, "processing");
        responseDirectory = Path.Combine(runtimeDirectory, "responses");
        Directory.CreateDirectory(requestDirectory);
        Directory.CreateDirectory(processingDirectory);
        Directory.CreateDirectory(responseDirectory);
    }

    public static int Main()
    {
        try
        {
            new DshEdgeNativeHost().Run();
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("DSH Edge Native Host fatal error: " + error.Message);
            return 1;
        }
    }

    private void Run()
    {
        Thread pipeThread = new Thread(PipeAcceptLoop) { IsBackground = true, Name = "DSH Edge Pipe" };
        pipeThread.Start();

        Thread cleanupThread = new Thread(CleanupLoop) { IsBackground = true, Name = "DSH Edge Cleanup" };
        cleanupThread.Start();

        Thread fileThread = new Thread(FileBridgeLoop) { IsBackground = true, Name = "DSH Edge File Bridge" };
        fileThread.Start();

        ReadNativeLoop();
        stopping = true;
    }

    private void ReadNativeLoop()
    {
        byte[] lengthBuffer = new byte[4];
        while (!stopping)
        {
            if (!ReadExact(nativeInput, lengthBuffer, 4)) break;
            int length = BitConverter.ToInt32(lengthBuffer, 0);
            if (length <= 0 || length > 64 * 1024 * 1024)
                throw new InvalidDataException("Invalid Native Messaging payload length: " + length);

            byte[] payload = new byte[length];
            if (!ReadExact(nativeInput, payload, length)) break;
            string message = Encoding.UTF8.GetString(payload);
            RouteExtensionMessage(message);
        }
    }

    private static bool ReadExact(Stream stream, byte[] buffer, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            int read = stream.Read(buffer, offset, count - offset);
            if (read <= 0) return false;
            offset += read;
        }
        return true;
    }

    private void RouteExtensionMessage(string message)
    {
        Dictionary<string, object> parsed;
        try { parsed = json.Deserialize<Dictionary<string, object>>(message); }
        catch { return; }

        object type;
        object requestIdValue;
        if (!parsed.TryGetValue("type", out type) || Convert.ToString(type) != "response") return;
        if (!parsed.TryGetValue("requestId", out requestIdValue)) return;

        string requestId = Convert.ToString(requestIdValue);
        PendingClient client;
        if (pending.TryRemove(requestId, out client))
        {
            try
            {
                lock (client.Writer)
                {
                    client.Writer.WriteLine(message);
                    client.Writer.Flush();
                }
            }
            catch { }
            finally
            {
                try { client.Writer.Dispose(); } catch { }
            }
            return;
        }

        PendingFile file;
        if (pendingFiles.TryRemove(requestId, out file))
        {
            try { WriteTextAtomic(file.ResponsePath, message); }
            catch (Exception error) { Console.Error.WriteLine("DSH file response error: " + error.Message); }
        }
    }

    private void FileBridgeLoop()
    {
        string heartbeatPath = Path.Combine(runtimeDirectory, "host-alive.json");
        DateTime nextHeartbeat = DateTime.MinValue;
        while (!stopping)
        {
            try
            {
                if (DateTime.UtcNow >= nextHeartbeat)
                {
                    WriteTextAtomic(heartbeatPath, json.Serialize(new { pid = System.Diagnostics.Process.GetCurrentProcess().Id, utc = DateTime.UtcNow.ToString("o") }));
                    nextHeartbeat = DateTime.UtcNow.AddSeconds(2);
                }

                foreach (string requestPath in Directory.GetFiles(requestDirectory, "*.json"))
                {
                    string processingPath = Path.Combine(processingDirectory, Path.GetFileName(requestPath));
                    try { File.Move(requestPath, processingPath); }
                    catch { continue; }
                    HandleFileRequest(processingPath);
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("DSH file bridge error: " + error.Message);
            }
            Thread.Sleep(25);
        }
    }

    private void HandleFileRequest(string processingPath)
    {
        string requestId = null;
        try
        {
            string request = File.ReadAllText(processingPath, Encoding.UTF8);
            Dictionary<string, object> parsed = json.Deserialize<Dictionary<string, object>>(request);
            object requestIdValue;
            if (!parsed.TryGetValue("requestId", out requestIdValue) || String.IsNullOrWhiteSpace(Convert.ToString(requestIdValue)))
                throw new InvalidDataException("requestId is required");

            requestId = Convert.ToString(requestIdValue);
            string responsePath = Path.Combine(responseDirectory, requestId + ".json");
            pendingFiles[requestId] = new PendingFile { ResponsePath = responsePath, CreatedUtc = DateTime.UtcNow };
            WriteNativeMessage(request);
        }
        catch (Exception error)
        {
            if (!String.IsNullOrWhiteSpace(requestId))
            {
                string responsePath = Path.Combine(responseDirectory, requestId + ".json");
                WriteTextAtomic(responsePath, json.Serialize(new { type = "response", requestId = requestId, ok = false, error = error.Message }));
            }
        }
        finally
        {
            try { File.Delete(processingPath); } catch { }
        }
    }

    private static void WriteTextAtomic(string path, string content)
    {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temporary, content, new UTF8Encoding(false));
        if (File.Exists(path)) File.Replace(temporary, path, null);
        else File.Move(temporary, path);
    }

    private void PipeAcceptLoop()
    {
        while (!stopping)
        {
            NamedPipeServerStream pipe = null;
            try
            {
                pipe = CreateSecuredPipe();
                pipe.WaitForConnection();
                NamedPipeServerStream accepted = pipe;
                pipe = null;
                Thread worker = new Thread(() => HandlePipeClient(accepted)) { IsBackground = true };
                worker.Start();
            }
            catch (Exception error)
            {
                try { if (pipe != null) pipe.Dispose(); } catch { }
                if (!stopping)
                {
                    Console.Error.WriteLine("DSH pipe accept error: " + error.Message);
                    Thread.Sleep(500);
                }
            }
        }
    }

    private static NamedPipeServerStream CreateSecuredPipe()
    {
        WindowsIdentity identity = WindowsIdentity.GetCurrent();
        PipeSecurity security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(identity.User, PipeAccessRights.FullControl, AccessControlType.Allow));
        return new NamedPipeServerStream(
            PipeName,
            PipeDirection.InOut,
            NamedPipeServerStream.MaxAllowedServerInstances,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            65536,
            65536,
            security);
    }

    private void HandlePipeClient(NamedPipeServerStream pipe)
    {
        StreamReader reader = null;
        StreamWriter writer = null;
        try
        {
            reader = new StreamReader(pipe, new UTF8Encoding(false), false, 65536, true);
            writer = new StreamWriter(pipe, new UTF8Encoding(false), 65536) { AutoFlush = true };
            string request = reader.ReadLine();
            if (String.IsNullOrWhiteSpace(request)) return;

            Dictionary<string, object> parsed = json.Deserialize<Dictionary<string, object>>(request);
            object requestIdValue;
            if (!parsed.TryGetValue("requestId", out requestIdValue) || String.IsNullOrWhiteSpace(Convert.ToString(requestIdValue)))
                throw new InvalidDataException("requestId is required");

            string requestId = Convert.ToString(requestIdValue);
            pending[requestId] = new PendingClient { Writer = writer, CreatedUtc = DateTime.UtcNow };
            writer = null;
            WriteNativeMessage(request);
        }
        catch (Exception error)
        {
            try
            {
                if (writer != null)
                {
                    writer.WriteLine(json.Serialize(new { type = "response", ok = false, error = error.Message }));
                    writer.Flush();
                }
            }
            catch { }
        }
        finally
        {
            try { if (reader != null) reader.Dispose(); } catch { }
            if (writer != null)
            {
                try { writer.Dispose(); } catch { }
            }
        }
    }

    private void WriteNativeMessage(string message)
    {
        byte[] payload = Encoding.UTF8.GetBytes(message);
        byte[] length = BitConverter.GetBytes(payload.Length);
        lock (nativeWriteLock)
        {
            nativeOutput.Write(length, 0, length.Length);
            nativeOutput.Write(payload, 0, payload.Length);
            nativeOutput.Flush();
        }
    }

    private void CleanupLoop()
    {
        while (!stopping)
        {
            Thread.Sleep(30000);
            DateTime cutoff = DateTime.UtcNow.AddMinutes(-5);
            foreach (KeyValuePair<string, PendingClient> item in pending)
            {
                if (item.Value.CreatedUtc >= cutoff) continue;
                PendingClient removed;
                if (!pending.TryRemove(item.Key, out removed)) continue;
                try
                {
                    lock (removed.Writer)
                    {
                        removed.Writer.WriteLine(json.Serialize(new { type = "response", requestId = item.Key, ok = false, error = "Native Host request timed out" }));
                        removed.Writer.Flush();
                    }
                }
                catch { }
                finally
                {
                    try { removed.Writer.Dispose(); } catch { }
                }
            }

            foreach (KeyValuePair<string, PendingFile> item in pendingFiles)
            {
                if (item.Value.CreatedUtc >= cutoff) continue;
                PendingFile removed;
                if (!pendingFiles.TryRemove(item.Key, out removed)) continue;
                try
                {
                    WriteTextAtomic(removed.ResponsePath, json.Serialize(new { type = "response", requestId = item.Key, ok = false, error = "Native Host request timed out" }));
                }
                catch { }
            }

            DeleteStaleFiles(responseDirectory, DateTime.UtcNow.AddMinutes(-10));
            DeleteStaleFiles(processingDirectory, DateTime.UtcNow.AddMinutes(-10));
        }
    }

    private static void DeleteStaleFiles(string directory, DateTime cutoffUtc)
    {
        try
        {
            foreach (string path in Directory.GetFiles(directory))
            {
                try { if (File.GetLastWriteTimeUtc(path) < cutoffUtc) File.Delete(path); }
                catch { }
            }
        }
        catch { }
    }
}

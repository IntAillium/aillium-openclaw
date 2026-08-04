#include <node_api.h>
#include <windows.h>

#include <fcntl.h>
#include <io.h>

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

struct JobEntry {
  HANDLE handle;
  std::wstring name;
};

std::mutex g_handles_mutex;
std::unordered_map<std::string, JobEntry> g_jobs;
std::unordered_map<std::string, HANDLE> g_processes;
std::unordered_map<std::string, HANDLE> g_threads;
std::atomic<std::uint64_t> g_token_sequence{1};

std::string NewToken(const char* prefix) {
  return std::string(prefix) + ":" + std::to_string(GetCurrentProcessId()) + ":" +
         std::to_string(g_token_sequence.fetch_add(1));
}

napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

napi_value Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}

std::string WindowsErrorMessage(DWORD code) {
  LPWSTR buffer = nullptr;
  const DWORD length = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
          FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr, code, 0, reinterpret_cast<LPWSTR>(&buffer), 0, nullptr);
  if (!length || !buffer) {
    return "Windows error " + std::to_string(code);
  }
  const int utf8_length =
      WideCharToMultiByte(CP_UTF8, 0, buffer, static_cast<int>(length), nullptr, 0, nullptr, nullptr);
  std::string message(static_cast<std::size_t>(utf8_length), '\0');
  WideCharToMultiByte(CP_UTF8, 0, buffer, static_cast<int>(length), message.data(), utf8_length,
                      nullptr, nullptr);
  LocalFree(buffer);
  while (!message.empty() && (message.back() == '\r' || message.back() == '\n' ||
                              message.back() == ' ')) {
    message.pop_back();
  }
  return message;
}

napi_value ThrowWindows(napi_env env, const char* operation) {
  const DWORD code = GetLastError();
  return Throw(env, std::string(operation) + " failed: " + WindowsErrorMessage(code));
}

bool GetUtf8(napi_env env, napi_value value, std::string* output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    return false;
  }
  output->resize(length + 1);
  const bool read =
      napi_get_value_string_utf8(env, value, output->data(), output->size(), &length) == napi_ok;
  output->resize(read ? length : 0);
  return read;
}

bool GetUtf16(napi_env env, napi_value value, std::wstring* output) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) {
    return false;
  }
  output->resize(length + 1);
  const bool read = napi_get_value_string_utf16(
                        env, value, reinterpret_cast<char16_t*>(output->data()), output->size(),
                        &length) == napi_ok;
  output->resize(read ? length : 0);
  return read;
}

bool GetNamedProperty(napi_env env, napi_value object, const char* name, napi_value* output) {
  bool has_property = false;
  if (napi_has_named_property(env, object, name, &has_property) != napi_ok || !has_property) {
    return false;
  }
  return napi_get_named_property(env, object, name, output) == napi_ok;
}

napi_value String(napi_env env, const std::string& value) {
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

napi_value WideString(napi_env env, const std::wstring& value) {
  napi_value result;
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(value.c_str()), value.size(),
                           &result);
  return result;
}

void Set(napi_env env, napi_value object, const char* name, napi_value value) {
  napi_set_named_property(env, object, name, value);
}

HANDLE FindJob(const std::string& token, std::wstring* name = nullptr) {
  std::lock_guard<std::mutex> lock(g_handles_mutex);
  const auto found = g_jobs.find(token);
  if (found == g_jobs.end()) {
    return nullptr;
  }
  if (name) {
    *name = found->second.name;
  }
  return found->second.handle;
}

HANDLE FindHandle(const std::unordered_map<std::string, HANDLE>& handles,
                  const std::string& token) {
  std::lock_guard<std::mutex> lock(g_handles_mutex);
  const auto found = handles.find(token);
  return found == handles.end() ? nullptr : found->second;
}

bool ReadSingleStringArg(napi_env env, napi_callback_info info, std::string* value) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    Throw(env, "expected one string argument");
    return false;
  }
  if (!GetUtf8(env, argv[0], value)) {
    Throw(env, "expected one string argument");
    return false;
  }
  return true;
}

bool ReadTokenAndExitCode(napi_env env, napi_callback_info info, std::string* token,
                          UINT* exit_code) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      !GetUtf8(env, argv[0], token)) {
    Throw(env, "expected token and exit code");
    return false;
  }
  std::uint32_t parsed = 0;
  if (napi_get_value_uint32(env, argv[1], &parsed) != napi_ok) {
    Throw(env, "expected token and exit code");
    return false;
  }
  *exit_code = parsed;
  return true;
}

std::string FileTimeString(const FILETIME& value) {
  ULARGE_INTEGER combined{};
  combined.LowPart = value.dwLowDateTime;
  combined.HighPart = value.dwHighDateTime;
  return std::to_string(combined.QuadPart);
}

bool QueryCreationTime(HANDLE process, std::string* output) {
  FILETIME creation{}, exit{}, kernel{}, user{};
  if (!GetProcessTimes(process, &creation, &exit, &kernel, &user)) {
    return false;
  }
  *output = FileTimeString(creation);
  return true;
}

napi_value CreateJob(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return Throw(env, "createJob expects one job name");
  }
  std::wstring name;
  if (!GetUtf16(env, argv[0], &name) || name.empty()) {
    return Throw(env, "createJob expects a non-empty job name");
  }
  HANDLE handle = CreateJobObjectW(nullptr, name.c_str());
  if (!handle) {
    return ThrowWindows(env, "CreateJobObjectW");
  }
  const std::string token = NewToken("job");
  {
    std::lock_guard<std::mutex> lock(g_handles_mutex);
    g_jobs.emplace(token, JobEntry{handle, name});
  }
  return String(env, token);
}

napi_value OpenJob(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return Throw(env, "openJob expects one job name");
  }
  std::wstring name;
  if (!GetUtf16(env, argv[0], &name) || name.empty()) {
    return Throw(env, "openJob expects a non-empty job name");
  }
  HANDLE handle = OpenJobObjectW(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE |
                                      JOB_OBJECT_ASSIGN_PROCESS,
                                  FALSE, name.c_str());
  if (!handle) {
    if (GetLastError() == ERROR_FILE_NOT_FOUND) {
      return Undefined(env);
    }
    return ThrowWindows(env, "OpenJobObjectW");
  }
  const std::string token = NewToken("job");
  {
    std::lock_guard<std::mutex> lock(g_handles_mutex);
    g_jobs.emplace(token, JobEntry{handle, name});
  }
  return String(env, token);
}

napi_value SetKillOnJobClose(napi_env env, napi_callback_info info) {
  std::string token;
  if (!ReadSingleStringArg(env, info, &token)) {
    return nullptr;
  }
  HANDLE job = FindJob(token);
  if (!job) {
    return Throw(env, "unknown job token");
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    return ThrowWindows(env, "SetInformationJobObject");
  }
  return Undefined(env);
}

bool CreateCapturedPipe(HANDLE* parent_end, HANDLE* child_end, bool parent_reads) {
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE read_handle = nullptr;
  HANDLE write_handle = nullptr;
  if (!CreatePipe(&read_handle, &write_handle, &attributes, 0)) {
    return false;
  }
  *parent_end = parent_reads ? read_handle : write_handle;
  *child_end = parent_reads ? write_handle : read_handle;
  if (!SetHandleInformation(*parent_end, HANDLE_FLAG_INHERIT, 0)) {
    const DWORD error = GetLastError();
    CloseHandle(read_handle);
    CloseHandle(write_handle);
    *parent_end = nullptr;
    *child_end = nullptr;
    SetLastError(error);
    return false;
  }
  return true;
}

bool CreateInheritedStdin(HANDLE* child_stdin) {
  const HANDLE source = GetStdHandle(STD_INPUT_HANDLE);
  if (source && source != INVALID_HANDLE_VALUE &&
      DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), child_stdin, 0, TRUE,
                      DUPLICATE_SAME_ACCESS)) {
    return true;
  }
  SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  *child_stdin = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes,
                             OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  return *child_stdin != INVALID_HANDLE_VALUE;
}

std::vector<wchar_t> BuildEnvironmentBlock(napi_env env, napi_value array) {
  std::vector<wchar_t> block;
  std::uint32_t length = 0;
  if (napi_get_array_length(env, array, &length) != napi_ok) {
    return block;
  }
  for (std::uint32_t index = 0; index < length; ++index) {
    napi_value item;
    std::wstring entry;
    if (napi_get_element(env, array, index, &item) != napi_ok || !GetUtf16(env, item, &entry)) {
      block.clear();
      return block;
    }
    block.insert(block.end(), entry.begin(), entry.end());
    block.push_back(L'\0');
  }
  if (block.empty()) {
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

napi_value CreateProcessSuspended(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
    return Throw(env, "createProcessSuspended expects one options object");
  }
  napi_value command_line_value, environment_value, stdin_mode_value, cwd_value;
  if (!GetNamedProperty(env, argv[0], "commandLine", &command_line_value) ||
      !GetNamedProperty(env, argv[0], "environment", &environment_value) ||
      !GetNamedProperty(env, argv[0], "stdinMode", &stdin_mode_value)) {
    return Throw(env, "createProcessSuspended options are incomplete");
  }
  std::wstring command_line;
  std::string stdin_mode;
  if (!GetUtf16(env, command_line_value, &command_line) || command_line.empty() ||
      !GetUtf8(env, stdin_mode_value, &stdin_mode)) {
    return Throw(env, "createProcessSuspended options are invalid");
  }
  if (stdin_mode != "inherit" && stdin_mode != "pipe-open" && stdin_mode != "pipe-closed") {
    return Throw(env, "createProcessSuspended stdinMode is invalid");
  }
  std::wstring cwd;
  const bool has_cwd = GetNamedProperty(env, argv[0], "cwd", &cwd_value) &&
                       GetUtf16(env, cwd_value, &cwd) && !cwd.empty();
  auto environment = BuildEnvironmentBlock(env, environment_value);
  if (environment.empty()) {
    return Throw(env, "createProcessSuspended environment is invalid");
  }

  HANDLE stdout_parent = nullptr, stdout_child = nullptr;
  HANDLE stderr_parent = nullptr, stderr_child = nullptr;
  HANDLE stdin_parent = nullptr, stdin_child = nullptr;
  if (!CreateCapturedPipe(&stdout_parent, &stdout_child, true) ||
      !CreateCapturedPipe(&stderr_parent, &stderr_child, true)) {
    const DWORD error = GetLastError();
    if (stdout_parent) {
      CloseHandle(stdout_parent);
    }
    if (stdout_child) {
      CloseHandle(stdout_child);
    }
    if (stderr_parent) {
      CloseHandle(stderr_parent);
    }
    if (stderr_child) {
      CloseHandle(stderr_child);
    }
    SetLastError(error);
    return ThrowWindows(env, "CreatePipe");
  }
  const bool pipe_stdin = stdin_mode != "inherit";
  if ((pipe_stdin && !CreateCapturedPipe(&stdin_parent, &stdin_child, false)) ||
      (!pipe_stdin && !CreateInheritedStdin(&stdin_child))) {
    const DWORD error = GetLastError();
    CloseHandle(stdout_parent);
    CloseHandle(stdout_child);
    CloseHandle(stderr_parent);
    CloseHandle(stderr_child);
    SetLastError(error);
    return ThrowWindows(env, "CreatePipe");
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdOutput = stdout_child;
  startup.StartupInfo.hStdError = stderr_child;
  startup.StartupInfo.hStdInput = stdin_child;
  SIZE_T attribute_bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
  std::vector<std::max_align_t> attribute_storage(
      (attribute_bytes + sizeof(std::max_align_t) - 1) / sizeof(std::max_align_t));
  startup.lpAttributeList =
      reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
  if (!startup.lpAttributeList ||
      !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attribute_bytes)) {
    const DWORD error = GetLastError();
    CloseHandle(stdout_parent);
    CloseHandle(stdout_child);
    CloseHandle(stderr_parent);
    CloseHandle(stderr_child);
    if (stdin_parent) {
      CloseHandle(stdin_parent);
    }
    CloseHandle(stdin_child);
    SetLastError(error);
    return ThrowWindows(env, "InitializeProcThreadAttributeList");
  }
  HANDLE inherited_handles[] = {stdin_child, stdout_child, stderr_child};
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0,
                                 PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited_handles,
                                 sizeof(inherited_handles), nullptr, nullptr)) {
    const DWORD error = GetLastError();
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    CloseHandle(stdout_parent);
    CloseHandle(stdout_child);
    CloseHandle(stderr_parent);
    CloseHandle(stderr_child);
    if (stdin_parent) {
      CloseHandle(stdin_parent);
    }
    CloseHandle(stdin_child);
    SetLastError(error);
    return ThrowWindows(env, "UpdateProcThreadAttribute");
  }
  PROCESS_INFORMATION process{};
  std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');
  const BOOL created = CreateProcessW(
      nullptr, mutable_command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW |
          EXTENDED_STARTUPINFO_PRESENT,
      environment.data(), has_cwd ? cwd.c_str() : nullptr, &startup.StartupInfo, &process);
  const DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  CloseHandle(stdout_child);
  CloseHandle(stderr_child);
  if (stdin_child) {
    CloseHandle(stdin_child);
  }
  if (!created) {
    CloseHandle(stdout_parent);
    CloseHandle(stderr_parent);
    if (stdin_parent) {
      CloseHandle(stdin_parent);
    }
    SetLastError(create_error);
    return ThrowWindows(env, "CreateProcessW");
  }

  const int stdout_fd = _open_osfhandle(reinterpret_cast<intptr_t>(stdout_parent), _O_RDONLY | _O_BINARY);
  const int stderr_fd = _open_osfhandle(reinterpret_cast<intptr_t>(stderr_parent), _O_RDONLY | _O_BINARY);
  const int stdin_fd = stdin_parent
                           ? _open_osfhandle(reinterpret_cast<intptr_t>(stdin_parent),
                                            _O_WRONLY | _O_BINARY)
                           : -1;
  if (stdout_fd < 0 || stderr_fd < 0 || (stdin_parent && stdin_fd < 0)) {
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    stdout_fd >= 0 ? _close(stdout_fd) : CloseHandle(stdout_parent);
    stderr_fd >= 0 ? _close(stderr_fd) : CloseHandle(stderr_parent);
    if (stdin_parent) {
      stdin_fd >= 0 ? _close(stdin_fd) : CloseHandle(stdin_parent);
    }
    return Throw(env, "failed to convert Windows pipe handles to CRT descriptors");
  }

  std::string creation_time;
  if (!QueryCreationTime(process.hProcess, &creation_time)) {
    const DWORD error = GetLastError();
    TerminateProcess(process.hProcess, 1);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    _close(stdout_fd);
    _close(stderr_fd);
    if (stdin_fd >= 0) {
      _close(stdin_fd);
    }
    SetLastError(error);
    return ThrowWindows(env, "GetProcessTimes");
  }
  const std::string process_token = NewToken("process");
  const std::string thread_token = NewToken("thread");
  {
    std::lock_guard<std::mutex> lock(g_handles_mutex);
    g_processes.emplace(process_token, process.hProcess);
    g_threads.emplace(thread_token, process.hThread);
  }

  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_uint32(env, process.dwProcessId, &value);
  Set(env, result, "pid", value);
  Set(env, result, "creationTime", String(env, creation_time));
  Set(env, result, "processToken", String(env, process_token));
  Set(env, result, "primaryThreadToken", String(env, thread_token));
  napi_create_int32(env, stdout_fd, &value);
  Set(env, result, "stdoutFd", value);
  napi_create_int32(env, stderr_fd, &value);
  Set(env, result, "stderrFd", value);
  if (stdin_fd >= 0) {
    napi_create_int32(env, stdin_fd, &value);
    Set(env, result, "stdinFd", value);
  }
  return result;
}

napi_value AssignProcess(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  std::string job_token, process_token;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      !GetUtf8(env, argv[0], &job_token) || !GetUtf8(env, argv[1], &process_token)) {
    return Throw(env, "assignProcess expects job and process tokens");
  }
  HANDLE job = FindJob(job_token);
  HANDLE process = FindHandle(g_processes, process_token);
  if (!job || !process) {
    return Throw(env, "assignProcess received an unknown token");
  }
  if (!AssignProcessToJobObject(job, process)) {
    return ThrowWindows(env, "AssignProcessToJobObject");
  }
  return Undefined(env);
}

napi_value ResumePrimaryThread(napi_env env, napi_callback_info info) {
  std::string token;
  if (!ReadSingleStringArg(env, info, &token)) {
    return nullptr;
  }
  HANDLE thread = FindHandle(g_threads, token);
  if (!thread) {
    return Throw(env, "unknown primary thread token");
  }
  if (ResumeThread(thread) == static_cast<DWORD>(-1)) {
    return ThrowWindows(env, "ResumeThread");
  }
  return Undefined(env);
}

napi_value QueryJob(napi_env env, napi_callback_info info) {
  std::string token;
  if (!ReadSingleStringArg(env, info, &token)) {
    return nullptr;
  }
  std::wstring name;
  HANDLE job = FindJob(token, &name);
  if (!job) {
    return Throw(env, "unknown job token");
  }
  std::vector<std::uint8_t> buffer(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) +
                                   sizeof(ULONG_PTR) * 16);
  while (!QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer.data(),
                                    static_cast<DWORD>(buffer.size()), nullptr)) {
    if (GetLastError() != ERROR_MORE_DATA || buffer.size() > 1024 * 1024) {
      return ThrowWindows(env, "QueryInformationJobObject");
    }
    buffer.resize(buffer.size() * 2);
  }
  const auto* list = reinterpret_cast<const JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buffer.data());
  napi_value result, members, count;
  napi_create_object(env, &result);
  Set(env, result, "jobName", WideString(env, name));
  napi_create_array_with_length(env, list->NumberOfProcessIdsInList, &members);
  for (ULONG index = 0; index < list->NumberOfProcessIdsInList; ++index) {
    napi_value pid;
    napi_create_double(env, static_cast<double>(list->ProcessIdList[index]), &pid);
    napi_set_element(env, members, index, pid);
  }
  Set(env, result, "memberPids", members);
  napi_create_uint32(env, list->NumberOfProcessIdsInList, &count);
  Set(env, result, "activeProcessCount", count);
  return result;
}

napi_value QueryProcessIdentity(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  std::uint32_t pid = 0;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
      napi_get_value_uint32(env, argv[0], &pid) != napi_ok || pid == 0) {
    return Throw(env, "queryProcessIdentity expects a positive PID");
  }
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) {
    if (GetLastError() == ERROR_INVALID_PARAMETER) {
      return Undefined(env);
    }
    return ThrowWindows(env, "OpenProcess");
  }
  std::string creation_time;
  const bool queried = QueryCreationTime(process, &creation_time);
  const DWORD query_error = queried ? ERROR_SUCCESS : GetLastError();
  CloseHandle(process);
  if (!queried) {
    SetLastError(query_error);
    return ThrowWindows(env, "GetProcessTimes");
  }
  napi_value result, pid_value;
  napi_create_object(env, &result);
  napi_create_uint32(env, pid, &pid_value);
  Set(env, result, "pid", pid_value);
  Set(env, result, "creationTime", String(env, creation_time));
  return result;
}

napi_value QueryProcessExit(napi_env env, napi_callback_info info) {
  std::string token;
  if (!ReadSingleStringArg(env, info, &token)) {
    return nullptr;
  }
  HANDLE process = FindHandle(g_processes, token);
  if (!process) {
    return Throw(env, "unknown process token");
  }
  DWORD exit_code = 0;
  if (!GetExitCodeProcess(process, &exit_code)) {
    return ThrowWindows(env, "GetExitCodeProcess");
  }
  if (exit_code == STILL_ACTIVE) {
    return Undefined(env);
  }
  napi_value result;
  napi_create_uint32(env, exit_code, &result);
  return result;
}

napi_value TerminateProcessToken(napi_env env, napi_callback_info info) {
  std::string token;
  UINT exit_code = 1;
  if (!ReadTokenAndExitCode(env, info, &token, &exit_code)) {
    return nullptr;
  }
  HANDLE process = FindHandle(g_processes, token);
  if (!process) {
    return Throw(env, "unknown process token");
  }
  if (!TerminateProcess(process, exit_code)) {
    const DWORD terminate_error = GetLastError();
    DWORD current_exit_code = STILL_ACTIVE;
    if (terminate_error == ERROR_ACCESS_DENIED && GetExitCodeProcess(process, &current_exit_code) &&
        current_exit_code != STILL_ACTIVE) {
      return Undefined(env);
    }
    SetLastError(terminate_error);
    return ThrowWindows(env, "TerminateProcess");
  }
  return Undefined(env);
}

napi_value TerminateJob(napi_env env, napi_callback_info info) {
  std::string token;
  UINT exit_code = 1;
  if (!ReadTokenAndExitCode(env, info, &token, &exit_code)) {
    return nullptr;
  }
  HANDLE job = FindJob(token);
  if (!job) {
    return Throw(env, "unknown job token");
  }
  if (!TerminateJobObject(job, exit_code)) {
    return ThrowWindows(env, "TerminateJobObject");
  }
  return Undefined(env);
}

napi_value CloseProcessHandles(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  std::string process_token, thread_token;
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
      !GetUtf8(env, argv[0], &process_token) || !GetUtf8(env, argv[1], &thread_token)) {
    return Throw(env, "closeProcessHandles expects process and thread tokens");
  }
  std::lock_guard<std::mutex> lock(g_handles_mutex);
  if (const auto found = g_processes.find(process_token); found != g_processes.end()) {
    CloseHandle(found->second);
    g_processes.erase(found);
  }
  if (const auto found = g_threads.find(thread_token); found != g_threads.end()) {
    CloseHandle(found->second);
    g_threads.erase(found);
  }
  return Undefined(env);
}

napi_value CloseJob(napi_env env, napi_callback_info info) {
  std::string token;
  if (!ReadSingleStringArg(env, info, &token)) {
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(g_handles_mutex);
  if (const auto found = g_jobs.find(token); found != g_jobs.end()) {
    CloseHandle(found->second.handle);
    g_jobs.erase(found);
  }
  return Undefined(env);
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_value abi_version;
  napi_create_uint32(env, 1, &abi_version);
  Set(env, exports, "abiVersion", abi_version);
  const napi_property_descriptor methods[] = {
      {"createJob", nullptr, CreateJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"openJob", nullptr, OpenJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setKillOnJobClose", nullptr, SetKillOnJobClose, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"createProcessSuspended", nullptr, CreateProcessSuspended, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"assignProcess", nullptr, AssignProcess, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"resumePrimaryThread", nullptr, ResumePrimaryThread, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"queryJob", nullptr, QueryJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"queryProcessIdentity", nullptr, QueryProcessIdentity, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"queryProcessExit", nullptr, QueryProcessExit, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"terminateProcess", nullptr, TerminateProcessToken, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"terminateJob", nullptr, TerminateJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeProcessHandles", nullptr, CloseProcessHandles, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"closeJob", nullptr, CloseJob, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)

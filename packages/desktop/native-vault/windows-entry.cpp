#include <windows.h>
#include <wincred.h>
#include <cstdlib>
#include <cwchar>

// Separate from OS authentication. Never read existing passwords or persist in Credential Manager.
int wmain(int argc, wchar_t** argv) {
  if (argc != 6) return 3;
  wchar_t* end = nullptr;
  const auto handle = std::wcstoull(argv[1], &end, 16);
  const auto window = reinterpret_cast<HWND>(handle);
  const auto output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!handle || !end || *end || !IsWindow(window) || GetFileType(output) != FILE_TYPE_PIPE) return 3;
  wchar_t username[CREDUI_MAX_USERNAME_LENGTH + 1]{};
  wchar_t password[CREDUI_MAX_PASSWORD_LENGTH + 1]{};
  if (wcslen(argv[5]) > CREDUI_MAX_USERNAME_LENGTH) return 3;
  wcscpy_s(username, argv[5]);
  CREDUI_INFOW info{};
  info.cbSize = sizeof(info);
  info.hwndParent = window;
  info.pszCaptionText = argv[3];
  info.pszMessageText = argv[4];
  BOOL save = FALSE;
  const auto result = CredUIPromptForCredentialsW(
    &info, argv[2], nullptr, 0, username, ARRAYSIZE(username), password, ARRAYSIZE(password), &save,
    CREDUI_FLAGS_GENERIC_CREDENTIALS | CREDUI_FLAGS_ALWAYS_SHOW_UI | CREDUI_FLAGS_DO_NOT_PERSIST);
  int status = result == ERROR_CANCELLED ? 1 : 3;
  if (result == NO_ERROR && password[0]) {
    const DWORD lengths[] = {static_cast<DWORD>(wcslen(username) * sizeof(wchar_t)),
                             static_cast<DWORD>(wcslen(password) * sizeof(wchar_t))};
    const auto write = [output](const void* value, DWORD length) {
      DWORD written = 0;
      return WriteFile(output, value, length, &written, nullptr) && written == length;
    };
    status = write(lengths, sizeof(lengths)) && write(username, lengths[0]) && write(password, lengths[1]) ? 0 : 3;
  }
  SecureZeroMemory(username, sizeof(username));
  SecureZeroMemory(password, sizeof(password));
  return status;
}

#include <windows.h>
#include <userconsentverifierinterop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.UI.h>
#include <cstdlib>

// This helper receives only a window handle and UI reason, never vault data or keys.
// 0 means OS verification succeeded; every other exit status denies access.
int wmain(int argc, wchar_t** argv) {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    using winrt::Windows::Security::Credentials::UI::UserConsentVerifier;
    using winrt::Windows::Security::Credentials::UI::UserConsentVerifierAvailability;
    using winrt::Windows::Security::Credentials::UI::UserConsentVerificationResult;
    if (UserConsentVerifier::CheckAvailabilityAsync().get() != UserConsentVerifierAvailability::Available) return 2;
    if (argc == 2 && wcscmp(argv[1], L"--available") == 0) return 0;
    if (argc != 3) return 3;
    wchar_t* end = nullptr;
    const auto handle = std::wcstoull(argv[1], &end, 16);
    if (!handle || !end || *end) return 3;
    const auto window = reinterpret_cast<HWND>(handle);
    if (!IsWindow(window)) return 3;
    const auto factory = winrt::get_activation_factory<UserConsentVerifier, IUserConsentVerifierInterop>();
    winrt::Windows::Foundation::IAsyncOperation<UserConsentVerificationResult> operation{nullptr};
    const winrt::hstring reason{argv[2]};
    winrt::check_hresult(factory->RequestVerificationForWindowAsync(
      window, static_cast<HSTRING>(winrt::get_abi(reason)), winrt::guid_of<decltype(operation)>(), winrt::put_abi(operation)));
    return operation.get() == UserConsentVerificationResult::Verified ? 0 : 1;
  } catch (...) {
    return 3;
  }
}

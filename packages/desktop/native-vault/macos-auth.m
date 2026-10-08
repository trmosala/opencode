#import <AppKit/AppKit.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <stdlib.h>

// Device-owner authentication lets macOS offer Touch ID, Apple Watch or the
// current user's login password. The helper never receives the password.
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 3;
    NSString *reason = [NSString stringWithUTF8String:argv[1]];
    if (!reason.length) return 3;
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp activateIgnoringOtherApps:YES];
    LAContext *context = [LAContext new];
    NSError *error = nil;
    if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) return 3;
    [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication localizedReason:reason reply:^(BOOL success, NSError *failure) {
      // Only an exit status crosses back to Electron, never OS error details.
      dispatch_async(dispatch_get_main_queue(), ^{ exit(success ? 0 : 1); });
    }];
    [NSApp run];
    return 3;
  }
}

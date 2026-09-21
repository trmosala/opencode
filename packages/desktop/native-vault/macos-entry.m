#define __STDC_WANT_LIB_EXT1__ 1
#import <string.h>
#import <AppKit/AppKit.h>
#import <CoreFoundation/CoreFoundation.h>
#import <sys/stat.h>
#import <unistd.h>

@interface CMEntryFormatter : NSFormatter
@property NSUInteger maximumUnits;
@end

@implementation CMEntryFormatter
- (NSString *)stringForObjectValue:(id)value {
  return [value isKindOfClass:[NSString class]] ? value : @"";
}

- (BOOL)getObjectValue:(id *)object forString:(NSString *)string errorDescription:(NSString **)error {
  if (object) *object = string;
  return YES;
}

- (BOOL)isPartialStringValid:(NSString *)partial
           newEditingString:(NSString **)replacement
           errorDescription:(NSString **)error {
  return partial.length <= self.maximumUnits;
}
@end

static BOOL writeAll(int descriptor, const void *bytes, size_t length) {
  const uint8_t *cursor = bytes;
  while (length) {
    const ssize_t written = write(descriptor, cursor, length);
    if (written <= 0) return NO;
    cursor += written;
    length -= (size_t)written;
  }
  return YES;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 8) return 3;
    struct stat outputStat = {};
    if (fstat(STDOUT_FILENO, &outputStat) || (!S_ISFIFO(outputStat.st_mode) && !S_ISSOCK(outputStat.st_mode))) return 3;

    NSString *title = [NSString stringWithUTF8String:argv[3]];
    NSString *message = [NSString stringWithUTF8String:argv[4]];
    NSString *initialUsername = [NSString stringWithUTF8String:argv[5]];
    NSString *saveLabel = [NSString stringWithUTF8String:argv[6]];
    NSString *cancelLabel = [NSString stringWithUTF8String:argv[7]];
    if (!title || !message || !initialUsername || !saveLabel || !cancelLabel || initialUsername.length > 513) return 3;

    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];

    NSTextField *username = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 34, 360, 24)];
    username.placeholderString = @"Username";
    username.stringValue = initialUsername;
    CMEntryFormatter *usernameFormatter = [CMEntryFormatter new];
    usernameFormatter.maximumUnits = 513;
    username.formatter = usernameFormatter;

    NSSecureTextField *password = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(0, 0, 360, 24)];
    password.placeholderString = @"Password";
    CMEntryFormatter *passwordFormatter = [CMEntryFormatter new];
    passwordFormatter.maximumUnits = 256;
    password.formatter = passwordFormatter;

    NSView *accessory = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 360, 58)];
    [accessory addSubview:username];
    [accessory addSubview:password];

    NSAlert *alert = [NSAlert new];
    alert.messageText = title;
    alert.informativeText = message;
    alert.accessoryView = accessory;
    [alert addButtonWithTitle:saveLabel];
    [alert addButtonWithTitle:cancelLabel];
    alert.buttons[0].keyEquivalent = @"\r";
    alert.buttons[1].keyEquivalent = @"\e";

    [NSApp activateIgnoringOtherApps:YES];
    [alert.window makeFirstResponder:username];
    const NSModalResponse response = [alert runModal];
    if (response != NSAlertFirstButtonReturn) return 1;

    NSData *usernameData = [username.stringValue dataUsingEncoding:NSUTF16LittleEndianStringEncoding];
    NSData *passwordData = [password.stringValue dataUsingEncoding:NSUTF16LittleEndianStringEncoding];
    NSMutableData *usernameBytes = [usernameData mutableCopy];
    NSMutableData *passwordBytes = [passwordData mutableCopy];
    username.stringValue = @"";
    password.stringValue = @"";
    const BOOL valid = passwordBytes.length && usernameBytes.length <= 1026 && passwordBytes.length <= 512;
    const uint32_t lengths[] = {
      CFSwapInt32HostToLittle((uint32_t)usernameBytes.length),
      CFSwapInt32HostToLittle((uint32_t)passwordBytes.length),
    };
    const BOOL wrote = valid && writeAll(STDOUT_FILENO, lengths, sizeof(lengths)) &&
      writeAll(STDOUT_FILENO, usernameBytes.bytes, usernameBytes.length) &&
      writeAll(STDOUT_FILENO, passwordBytes.bytes, passwordBytes.length);
    // Darwin provides memset_s for clearing that cannot be optimized away.
    if (usernameBytes.length) memset_s(usernameBytes.mutableBytes, usernameBytes.length, 0, usernameBytes.length);
    if (passwordBytes.length) memset_s(passwordBytes.mutableBytes, passwordBytes.length, 0, passwordBytes.length);
    return wrote ? 0 : 3;
  }
}

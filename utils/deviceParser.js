const UAParser = require('ua-parser-js');

function parseDevice(userAgent) {
  if (!userAgent) return { device_type: 'unknown', os: 'Unknown', browser: 'Unknown', platform: 'web' };

  const parser = new UAParser(userAgent);
  const result = parser.getResult();

  const deviceType = result.device.type
    ? result.device.type === 'mobile' ? 'mobile'
    : result.device.type === 'tablet' ? 'tablet'
    : 'desktop'
    : 'desktop';

  const osName = result.os.name || 'Unknown';
  const browser = result.browser.name || 'Unknown';

  let platform = 'web';
  if (osName === 'iOS' || osName === 'iPadOS') platform = 'ios';
  else if (osName === 'Android') platform = 'android';

  return { device_type: deviceType, os: osName, browser, platform };
}

module.exports = { parseDevice };

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isChannelUrl, parseViews, parsePublishedDays, parseLockups, channelVideosUrl, parseEpisodeNumber } from './channel-search.js'

test('isChannelUrl: nhận /channel, /@, /c, /user; loại watch/playlist', () => {
  assert.equal(isChannelUrl('https://www.youtube.com/channel/UC9LW_AwhGe-cMDgEJ84XD6w'), true)
  assert.equal(isChannelUrl('https://www.youtube.com/@GhienReviewOfficial'), true)
  assert.equal(isChannelUrl('https://www.youtube.com/@ten/videos'), true)
  assert.equal(isChannelUrl('https://www.youtube.com/c/SomeName'), true)
  assert.equal(isChannelUrl('https://www.youtube.com/watch?v=abc12345678'), false)
  assert.equal(isChannelUrl('https://www.youtube.com/playlist?list=PLx'), false)
  assert.equal(isChannelUrl('not a url'), false)
})

test('parseViews đọc số kiểu Việt và Anh', () => {
  assert.equal(parseViews('156 lượt xem'), 156)
  assert.equal(parseViews('1,2 tr lượt xem'), 1200000)
  assert.equal(parseViews('12 N lượt xem'), 12000)
  assert.equal(parseViews('1.2M views'), 1200000)
  assert.equal(parseViews('3.4K views'), 3400)
  assert.equal(parseViews('1.234 lượt xem'), 1234)
})

test('parsePublishedDays quy về số ngày', () => {
  assert.equal(parsePublishedDays('6 tháng trước'), 180)
  assert.equal(parsePublishedDays('2 tuần trước'), 14)
  assert.equal(parsePublishedDays('3 ngày trước'), 3)
  assert.equal(parsePublishedDays('1 năm trước'), 365)
  assert.equal(parsePublishedDays('5 giờ trước'), 0)
})

test('channelVideosUrl thêm /videos, bỏ đuôi tab cũ', () => {
  assert.equal(channelVideosUrl('https://www.youtube.com/@ten'), 'https://www.youtube.com/@ten/videos')
  assert.equal(channelVideosUrl('https://www.youtube.com/@ten/featured'), 'https://www.youtube.com/@ten/videos')
})

test('parseLockups đọc video từ lockupViewModel', () => {
  const data = { x: { lockupViewModel: {
    contentId: 'abcdefghijk',
    metadata: { lockupMetadataViewModel: {
      title: { content: 'Phim Hay Tập 1' },
      metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [
        { text: { content: '1,2 tr lượt xem' } }, { text: { content: '3 ngày trước' } },
      ] }] } },
    } },
  } } }
  const v = parseLockups(data)
  assert.equal(v.length, 1)
  assert.equal(v[0].id, 'abcdefghijk')
  assert.equal(v[0].title, 'Phim Hay Tập 1')
  assert.equal(v[0].views, 1200000)
  assert.equal(v[0].daysAgo, 3)
  assert.equal(v[0].url, 'https://www.youtube.com/watch?v=abcdefghijk')
})

test('parseEpisodeNumber lấy số tập từ tiêu đề', () => {
  assert.equal(parseEpisodeNumber('Đấu La Đại Lục Tập 5'), 5)
  assert.equal(parseEpisodeNumber('Phim Hay | Tập 1 - 25'), 1)
  assert.equal(parseEpisodeNumber('Something Episode 12'), 12)
  assert.equal(parseEpisodeNumber('Movie ep 3'), 3)
  assert.equal(parseEpisodeNumber('Phim lẻ không có tập'), Infinity)
})

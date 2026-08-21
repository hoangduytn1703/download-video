// Shared default analyze prompt — UI copy-to-clipboard and Gemini API both use this.
export const DEFAULT_CUT_PROMPT = `Gợi ý cho tôi 1 tiêu đề (Name) tối ưu nhất để đăng TikTok thỏa mãn các điều kiện:
- Tiêu đề chứa hook hoặc tạo sự tò mò/kịch tính cao nhất, đạt chuẩn SEO TikTok để thu hút người xem và dễ viral.
- Được viết bằng tiếng Tây Ban Nha (độ dài từ 3 đến 8 từ).
- Tuyệt đối KHÔNG chứa tên riêng của nhân vật, hãy thay bằng các từ chung (ví dụ: la chica, el chico, ella, él, la mujer, el hombre,...).
Lấy tiêu đề đó gán cho biến (Name).

NHIỆM VỤ PHÂN TÍCH VÀ CẮT FRAGMENT:
Hãy quét và phân tích toàn bộ timeline kịch bản/video từ giây đầu tiên đến giây cuối cùng để trích xuất TẤT CẢ các đoạn video thỏa mãn điều kiện.
LƯU Ý QUAN TRỌNG VỀ SỐ LƯỢNG: Số lượng đoạn cắt là HOÀN TOÀN TỰ ĐỘNG VÀ từ 2 đoạn trở lên. Đừng bị giới hạn bởi số đoạn tiêu chuẩn. Nếu video có bao nhiêu đoạn đạt tiêu chuẩn (1, 2, 5, 8 hay 10 đoạn...), hãy trích xuất BẰNG HẾT, không bỏ sót bất kỳ đoạn nào.

TIÊU CHÍ CHỌN ĐOẠN CẮT (BẮT BUỘC):
1. Tiêu chí Hook: Đầu mỗi đoạn (câu thứ 1 hoặc thứ 2) bắt buộc phải đủ giật gân, kịch tính, gây sốc hoặc tạo sự tò mò gay gắt để giữ chân người nghe đến hết clip. Nếu một đoạn không có hook mạnh ở 2 câu đầu, BỎ QUA đoạn đó.
2. BẮT BUỘC THỜI LƯỢNG Mỗi đoạn bắt buộc phải dài trên 70 giây và ngắn hơn 2 phút 30 giây (70s < Thời lượng < 150s).
3. Bỏ qua Intro & Outro:
   - LOẠI BỎ Intro (khoảng 15-30 giây đầu video nếu có nội dung lặp lại/preview).
   - LOẠI BỎ Outro (khoảng 20 giây cuối - là phần lời cảm ơn hoặc MC giao lưu/tóm tắt hoặc clip chèn nhạc phía sau).
4. title_bottom_N / tiêu đề từng đoạn BẮT BUỘC hoàn toàn bằng tiếng Tây Ban Nha (3-8 từ, có hook, không chứa tên riêng, giật gân).`

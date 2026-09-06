// Phòng ban để nhóm/quản lý kênh TikTok theo cây phân cấp.
// Cấu trúc: mỗi phòng ban { id, name, parentId, createdAt }. parentId = null là cấp CAO NHẤT
// (công ty) — chỉ được 1. Tối đa 5 cấp (công ty = cấp 1). Kênh gán vào phòng ban qua deptId,
// có thể nằm ở BẤT KỲ cấp nào; deptId null = "Chưa phân nhóm".
// Các hàm ở đây thuần (không đụng Date/random/IO) để test được; id do nơi gọi cấp.
export const MAX_DEPTH = 5

export function normalizeDepts(depts) {
  return Array.isArray(depts) ? depts.filter(d => d && d.id) : []
}
export function deptById(depts, id) {
  return normalizeDepts(depts).find(d => d.id === id) || null
}
export function rootDept(depts) {
  return normalizeDepts(depts).find(d => !d.parentId) || null
}
export function childrenOf(depts, id) {
  return normalizeDepts(depts).filter(d => (d.parentId || null) === (id || null))
}
// Độ sâu: công ty (parentId null) = 1. Có chặn vòng lặp phòng khi dữ liệu hỏng.
export function deptDepth(depts, id) {
  let d = deptById(depts, id)
  let n = 0
  const seen = new Set()
  while (d && !seen.has(d.id)) {
    seen.add(d.id)
    n++
    d = d.parentId ? deptById(depts, d.parentId) : null
  }
  return n
}

// Kiểm tra trước khi tạo phòng ban mới. parentId null = tạo cấp cao nhất (công ty).
export function validateNewDept(depts, { name, parentId } = {}) {
  const nm = String(name || '').trim()
  if (!nm) return { ok: false, message: 'Chưa nhập tên phòng ban' }
  if (nm.length > 60) return { ok: false, message: 'Tên phòng ban quá dài (tối đa 60 ký tự)' }
  if (!parentId) {
    if (rootDept(depts)) return { ok: false, message: 'Chỉ được 1 cấp cao nhất (công ty). Hãy tạo phòng con bên trong nó.' }
    return { ok: true }
  }
  const parent = deptById(depts, parentId)
  if (!parent) return { ok: false, message: 'Phòng ban cha không tồn tại' }
  if (deptDepth(depts, parentId) >= MAX_DEPTH) {
    return { ok: false, message: `Đã đạt tối đa ${MAX_DEPTH} cấp — không tạo sâu hơn được` }
  }
  return { ok: true }
}

export function addDept(depts, dept) {
  return [...normalizeDepts(depts), dept]
}
export function renameDept(depts, id, name) {
  const nm = String(name || '').trim()
  return normalizeDepts(depts).map(d => (d.id === id ? { ...d, name: nm } : d))
}
// Xóa: chặn nếu còn phòng con (xóa con trước). Kênh trong phòng do nơi gọi chuyển về "chưa phân nhóm".
export function canRemoveDept(depts, id) {
  if (!deptById(depts, id)) return { ok: false, message: 'Phòng ban không tồn tại' }
  if (childrenOf(depts, id).length) return { ok: false, message: 'Còn phòng con bên trong — xóa hoặc chuyển các phòng con trước đã' }
  return { ok: true }
}
export function removeDept(depts, id) {
  return normalizeDepts(depts).filter(d => d.id !== id)
}

// deptId hợp lệ để gán cho kênh: null (bỏ nhóm) hoặc id của 1 phòng đang tồn tại.
export function isValidAssign(depts, deptId) {
  if (deptId === null || deptId === undefined || deptId === '') return true
  return Boolean(deptById(depts, deptId))
}

// Cây phòng ban (kèm depth) để hiển thị — mỗi node { ...dept, depth, children:[...] }
export function deptTree(depts) {
  const list = normalizeDepts(depts)
  const build = parentId =>
    list
      .filter(d => (d.parentId || null) === parentId)
      .map(d => ({ ...d, depth: deptDepth(list, d.id), children: build(d.id) }))
  return build(null)
}

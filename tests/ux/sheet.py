import sys
from PIL import Image, ImageDraw
src, out, maxp = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv)>3 else 6
im=Image.open(src); W,H=im.size; ph=844
n=min(maxp,(H+ph-1)//ph)
sheet=Image.new('RGB',(n*(W+12),ph),'white')
for i in range(n):
    sheet.paste(im.crop((0,i*ph,W,min(H,(i+1)*ph))),(i*(W+12),0))
    ImageDraw.Draw(sheet).text((i*(W+12)+4,4),f'screen {i+1}',fill='red')
sheet.save(out)

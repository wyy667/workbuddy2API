"""Vendor simplified Natural Earth boundaries; public domain, no runtime requests."""
import json, math, hashlib
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/'

def simplify(points, epsilon=.045):
    if len(points) <= 2: return points
    ax, ay = points[0][:2]; bx, by = points[-1][:2]
    dx, dy = bx-ax, by-ay; denom = dx*dx+dy*dy
    maximum, index = 0, 0
    for i, p in enumerate(points[1:-1], 1):
        t = max(0,min(1, ((p[0]-ax)*dx+(p[1]-ay)*dy)/denom)) if denom else 0
        d = (p[0]-ax-t*dx)**2+(p[1]-ay-t*dy)**2
        if d > maximum: maximum, index = d, i
    if maximum > epsilon**2:
        return simplify(points[:index+1],epsilon)[:-1]+simplify(points[index:],epsilon)
    return [points[0],points[-1]]

def project(p):
    lon,lat=p[:2]
    lat=max(-80,min(84,lat))
    return round((lon+180)*4,2), round(360- math.log(math.tan(math.pi/4+math.radians(lat)/2))*720/math.pi,2)

def svgline(points, closed=False):
    p=[project(x) for x in simplify(points)]
    if len(p)<3 and closed: return ''
    return 'M'+'L'.join(f'{x:g},{y:g}' for x,y in p)+('Z' if closed else '')

out={}; sources=[]
for key,filename in [('countries','ne_50m_admin_0_countries.geojson'),('regions','ne_10m_admin_1_states_provinces_lines.geojson')]:
    response=requests.get(BASE+filename,timeout=120);response.raise_for_status()
    sources.append({'url':BASE+filename,'sha256':hashlib.sha256(response.content).hexdigest()})
    paths=[]; labels=[]
    for f in response.json()['features']:
        if not f.get('geometry'): continue
        g=f['geometry']; c=g['coordinates']; kind=g['type']
        if kind=='Polygon': paths.extend(svgline(r,True) for r in c)
        elif kind=='MultiPolygon': paths.extend(svgline(r,True) for p in c for r in p)
        elif kind=='LineString': paths.append(svgline(c))
        elif kind=='MultiLineString': paths.extend(svgline(r) for r in c)
        prop=f['properties']
        if key=='countries' and prop.get('POP_EST',0)>4000000 and prop.get('LABEL_X') is not None:
            x,y=project([prop['LABEL_X'],prop['LABEL_Y']])
            labels.append([prop.get('NAME_ZH') or prop['NAME'],x,y])
    out[key]=''.join(paths)
    if labels: out['labels']=labels
(ROOT/'src/assets').mkdir(exist_ok=True)
(ROOT/'src/assets/world-map.json').write_text(json.dumps(out,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
(ROOT/'licenses/Natural-Earth.json').write_text(json.dumps({'license':'Public domain','attribution':'Natural Earth','source':'https://www.naturalearthdata.com/about/','datasets':sources},indent=2),encoding='utf-8')
print({key:len(val) for key,val in out.items()})
